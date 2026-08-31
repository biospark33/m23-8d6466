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
 * ran. That combination refuses rather than promotes — and the SAME guard
 * (`refuseLiveInfraOnDecidable`) stands on every later route to a decidable
 * window: the rebind that refreshes one and `submitDecision` that writes the
 * authorizing record. A record that picks up live infrastructure after its
 * window opened refuses there too, rather than permitting an approval to
 * authorize a PR sitting over a live, billing box.
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
import { closeSync, existsSync, fstatSync, linkSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { assertExistingRunId, type ExtensionEntry, type RunRecord, type RunRecordStore } from "../providers/run-record.ts";
import { boundedEcho } from "../providers/step-log.ts";
// The shared JSONL sink, imported DIRECTLY rather than injected through
// `GateDeps` — a deliberate ruling, recorded here because the reverse was
// proposed and rejected (DF3.4 deferred item D1):
//
//  - It is not a new dependency edge. `run-record.ts`, which this module
//    already imports as a VALUE, imports this same sink; every sibling in
//    `src/fleet/` (dispatch, fanout, fanout-primitive) imports it directly too.
//  - `log.ts` is a leaf module with no imports of its own, and it ships
//    `setLogSink` expressly so tests can capture lines deterministically — so
//    the direct import costs nothing in testability either.
//  - An OPTIONAL seam is the shape that produced the round-6 teardown gap: a
//    caller that forgets to wire it gets silence indistinguishable from a
//    working one. The bug being fixed here IS a declared event with no
//    producer; a seam whose default is inert would rebuild it.
import { log } from "../swarmclaw/log.ts";
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
 * THE GUARANTEE, stated exactly, because for three review rounds this header
 * implied a stronger one than it delivered (deferred item D11):
 *
 *   While one process holds this lock, no other process enters `body()` for the
 *   same `runId` UNLESS the holder is PROVABLY DEAD (`kill(pid, 0)` → ESRCH),
 *   the lock file names NO holder at all and is past `LOCK_STALE_MS` (a
 *   zero-byte lock — one whose content write never landed — names no holder,
 *   and a lock naming no holder can never name a live one), or an operator has
 *   explicitly reclaimed it with `fleet unlock --force`.
 *
 * That is real mutual exclusion, not a narrow race: a provably-dead holder is
 * not executing anything, so reclaiming its lock cannot put two processes in
 * the critical section — and neither can reclaiming a lock that names no
 * holder, because there is nobody at `body()` behind it to collide with. It
 * was NOT true before D11 — an `age > 1h` door reclaimed regardless of
 * liveness, which surrendered exclusion by design and merely made the window
 * rare.
 *
 * THE PRICE, stated too: a holder whose pid can never be proven dead — the OS
 * recycled it onto a live unrelated process — wedges this run's approval verbs
 * at LOCK_TIMEOUT_MS forever. That is deliberate. A wedge is loud, bounded to
 * one run, and has an operator remedy (`fleet unlock`); a silent reclaim from a
 * live holder is none of those things.
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
 * How long a `withTeardownClaim` waiter waits for a live holder before
 * refusing. Teardown scale, NOT lock scale: a claim is legitimately held for
 * the whole of a teardown, which the module header puts at "seconds to
 * minutes", so this inherits the fleet's teardown ceiling
 * (`LOSER_TEARDOWN_TIMEOUT_MS`, fanout-primitive.ts) rather than the lock's
 * 5 s, which a real teardown blows through every time.
 */
const CLAIM_TIMEOUT_MS = 300_000;

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

/**
 * Best-effort write to fd 2 for the release path's diagnostics.
 *
 * Local rather than shared, matching `fleet-lock.ts:294` and
 * `run-record.ts:2214`, which are the same five lines for the same reason: the
 * ONE property that matters is that a diagnostic can never itself throw. Its
 * caller is a `finally` in a generic function, where a throw would replace
 * whatever `body()` raised — importing this from another module to save four
 * lines would trade that guarantee for a dependency edge.
 */
function noteOnStderr(line: string): void {
  try {
    process.stderr.write(line);
  } catch {
    // best-effort diagnostic only
  }
}

function lockHolderPid(raw: string): number | undefined {
  // Digits only, BEFORE coercion: `Number` reads "0x10" as 16 and " 12" as 12,
  // so a lock whose leading field is junk that merely coerces would be
  // attributed to a holder nobody wrote — and the dead-pid door would then
  // act (reclaim, or refuse to reclaim) on that invented pid.
  const head = raw.split(":", 1)[0] ?? "";
  if (!/^\d+$/.test(head)) return undefined;
  const pid = Number(head);
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
  // THIS acquisition's content, read by OTHER processes' reclaim path: the pid
  // lets a later waiter check the holder is actually dead (not just slow), and
  // the nonce makes the content unique per acquisition so reclamation cannot be
  // fooled by a replacement lock that happens to reuse the same pid.
  const ownContent = `${process.pid}:${randomUUID()}`;
  // THIS acquisition's IDENTITY, for the release in the finally. Content answers
  // "whose bytes are these" and needs a read; the inode answers "is this the
  // very file I created" and needs only a stat. The release fences on the
  // inode — see the finally for why identity, not content, is the right
  // question there.
  let ownIno = -1;
  for (;;) {
    try {
      // `openSync` + `fstatSync` rather than `writeFileSync` + `statSync`:
      // `wx` creates atomically, and fstat on OUR OWN fd reports the inode of
      // the file THIS call created with no window in which a replacement could
      // be measured instead. A `statSync(lockPath)` after the write would be a
      // second path lookup, and recording somebody else's inode would make the
      // release refuse to remove our own lock.
      const fd = openSync(lockPath, "wx", 0o600);
      try {
        // The content write is the acquisition's second half, and a failure
        // here must not strand an EMPTY lock behind a `wx` that can never be
        // re-created: every later waiter reads no parseable pid from it, so
        // no waiter can ever prove its holder dead, and the run wedges past
        // every timeout until an operator deletes the file by hand. Writing
        // INSIDE the open fd's try, and removing the file we created on the
        // way out, turns that stranded-empty shape into an ordinary retry.
        writeFileSync(fd, ownContent);
        ownIno = fstatSync(fd).ino;
      } catch (writeErr) {
        // Our own inode, not a content check: at this instant nothing else can
        // be at `lockPath` (the `wx` just succeeded and we hold the fd), so
        // identity is both sufficient and the cheaper question.
        try {
          if (ownIno === -1 || fstatSync(fd).ino === ownIno) rmSync(lockPath, { force: true });
        } catch {
          // If even the removal fails, leave the empty file and rethrow — the
          // next waiter's stale-age door then recovers it (an EMPTY lock names
          // no holder, so it reclaims past `LOCK_STALE_MS` without a pid; see
          // the EEXIST door below), which beats silently proceeding without a
          // lock.
        }
        throw writeErr;
      } finally {
        closeSync(fd);
      }
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      // ONE door, and it is PROOF OF DEATH — plus the one shape where death is
      // PROVABLE BY ABSENCE. Age is a precondition for looking, never a reason
      // to reclaim: a live holder can be suspended past LOCK_STALE_MS with its
      // mtime unchanged, so age alone is not evidence, and acting on it would
      // put a second process inside the critical section underneath a holder
      // that is still running `body()`. But a lock whose content names NO pid
      // at all — the zero-byte file a crash between the `wx` and the content
      // write strands — names no holder either, and a lock naming no holder can
      // never name a live one. Past LOCK_STALE_MS it is dead by construction
      // (the guarded body outlives the stale window, so a writer that was going
      // to land its content already has), and reclaiming it is the recovery the
      // content-write's failure path promises below.
      //
      // Everything else needs proof of death. There used to be a second door —
      // `age > LOCK_ABANDON_MS` (one hour), reclaiming regardless of liveness —
      // and removing it is deferred item D11. It existed for the case where
      // death can NEVER be proven: pids are recycled, so once the OS wraps onto
      // a dead holder's number, `process.kill(pid, 0)` succeeds for an
      // unrelated process and this check can never again say ESRCH. But a door
      // that reclaims from a possibly-live holder does not narrow a race, it
      // SURRENDERS mutual exclusion by design — three review rounds each found
      // a different symptom of it and each patched the release instead. The
      // wedge it protected against is real and is now answered where it
      // belongs: `fleet unlock <run-id>` is an explicit, auditable operator
      // action that says "I have checked, reclaim it", instead of an invisible
      // timer that says it on the operator's behalf.
      //
      // The release in the finally stays fenced on identity. It is no longer
      // load-bearing against this loop — a provably-dead holder is not running a
      // `finally` — but it is exactly what makes `fleet unlock --force` safe:
      // when an operator reclaims a live holder's lock, that holder's release
      // sees a different inode and correctly touches nothing.
      //
      // `claimed` tracks whether `renameSync` below has already moved a file
      // onto this process's private `claimPath`. Before that point a failure
      // (the lock vanishing between the stat and the read, e.g.) is benign —
      // nothing has moved, so falling through to retry is safe. Once this
      // process owns a file at `claimPath` it is holding either the dead
      // holder's lock or a live replacement's; ANY failure past that point
      // (a read, a restore rename, an unlink) must fail closed instead of
      // being swallowed — swallowing it would free `lockPath` for the next
      // loop iteration while the claimed content sits stranded off-path,
      // letting two processes both believe they hold the lock.
      let claimed = false;
      try {
        const age = Date.now() - statSync(lockPath).mtimeMs;
        if (age > LOCK_STALE_MS) {
          const raw = readFileSync(lockPath, "utf8");
          const pid = lockHolderPid(raw);
          // No pid (empty, truncated or unparseable content) is the stranded
          // zero-byte shape, reclaimable past the stale window per the door
          // comment above; a named pid still needs its proof of death.
          if (pid === undefined ? raw.trim() === "" : isLockHolderDead(pid)) {
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
                // created between the read above and the rename). Put the VERY
                // FILE back, never a copy of its bytes. A re-created file fails
                // twice: between the rename-away and a `wx` rewrite `lockPath`
                // is VACANT, so a third waiter creates it legitimately and
                // enters `body()` concurrently with the replacement holder —
                // and the rewrite mints a NEW inode, so the replacement's
                // fenced release (which stats the inode IT created) no longer
                // recognises its own lock and silently skips the removal,
                // wedging the lock until its pid dies.
                try {
                  // `link` is the atomic restore-if-absent POSIX CAN give: it
                  // fails EEXIST when a new holder re-took the path during the
                  // gap, where a check-then-rename — and a bare rename worse —
                  // CLOBBERS that holder's lock and puts two processes in
                  // `body()` at once. Stated exactly: the rename-away above
                  // DID vacate `lockPath`, and EEXIST is the proof a successor
                  // won that vacancy — what the link buys is that the restore
                  // itself adds no second vacancy, and that a losing restore
                  // clobbers nothing. On success the very inode the
                  // replacement's fenced release stats is back at `lockPath`;
                  // the claim name is then just a second name for the same
                  // file and is unlinked.
                  linkSync(claimPath, lockPath);
                  // UNGUARDED deliberately, and the one asymmetry in this
                  // block: the link has ALREADY succeeded, so the inode is
                  // back at `lockPath` and the replacement's fenced release
                  // is safe whatever happens here. If this unlink fails, the
                  // leftover claim name is a harmless second link to a file
                  // whose canonical path is correct — throwing would abandon
                  // a RESTORED lock (the `claimed` rethrow would surface a
                  // janitorial failure as a lock fault) while the danger the
                  // fence guards against is already over.
                  rmSync(claimPath, { force: true });
                } catch (restoreErr) {
                  if ((restoreErr as NodeJS.ErrnoException).code === "EEXIST") {
                    // A new holder re-took the path during the gap. The
                    // captured file is superseded, and discarding it strands
                    // nobody: its owner's fenced release stats the inode now
                    // at `lockPath`, sees it is not its own, and correctly
                    // touches nothing.
                    rmSync(claimPath, { force: true });
                  } else {
                    // Anything else is a filesystem fault: fail closed — and
                    // POISON the vacant `lockPath` before surfacing. The
                    // rename-away already vacated it, and rethrowing with the
                    // path still empty would let the next acquirer's `wx`
                    // succeed and enter `body()` alongside the live replacement
                    // holder this capture displaced — the exact two-in-`body()`
                    // shape this fence exists to prevent. A pid-less marker is
                    // never auto-reclaimed (`lockHolderPid` → undefined is
                    // non-empty content, so it fails the reclaim door), so it
                    // holds the path against every later acquirer until the
                    // operator's explicit `fleet unlock`, while the
                    // replacement's own fenced release stats a foreign inode
                    // and correctly touches nothing. Best-effort: if the marker
                    // write itself fails, the path stays VACANT — a successor's
                    // `wx` will then succeed, which is safe only because a
                    // successor that re-took the path in the gap (EEXIST) needs
                    // no marker at all; the message below says which of the two
                    // states the operator is actually walking into.
                    let poisoned = true;
                    try {
                      writeFileSync(lockPath, `0:${randomUUID()}`, { flag: "wx", mode: 0o600 });
                    } catch {
                      // vacant-and-unwritable joins stranded-at-claimPath as an
                      // operator-recovery state; the message below names both.
                      poisoned = false;
                    }
                    // The captured file stays preserved at `claimPath` for
                    // operator recovery — never swallow this and retry past a
                    // claimed lock (the `claimed` rethrow below enforces that).
                    throw new Error(
                      `approval lock reclaim: failed to restore replacement lock from ${claimPath} back to ${lockPath}; ${
                        poisoned
                          ? `a poison marker now holds ${lockPath}`
                          : `the poison-marker write FAILED too, so ${lockPath} is VACANT — do not rely on it being held`
                      } — inspect both by hand and recover with \`fleet unlock\`: ${(restoreErr as Error).message}`,
                    );
                  }
                }
              }
            }
          }
        }
      } catch (err) {
        if (claimed) throw err; // own a claimed lock file — fail closed, never retry past it
        // ONLY a vanish is benign: the lock was released between the failed
        // `wx` and the stat/read, so a retry finds a free path. Anything else
        // — EACCES, EMFILE, a corrupt read — is a filesystem FAULT, and
        // swallowing it as "retry" burns the whole wait budget and then
        // misattributes the fault to lock contention ("held for over 5000ms").
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `approval lock ${lockPath} held for over ${LOCK_TIMEOUT_MS}ms; if no reverify is running, its holder's pid may have been recycled — run \`fleet unlock ${runId}\` to inspect the holder and reclaim it`,
        );
      }
      await Bun.sleep(LOCK_POLL_MS);
    }
  }
  try {
    return await body();
  } finally {
    // FENCED, not an unconditional `rmSync`. Reclamation is nonce-checked on
    // the acquire side, but the release was not — and the two are halves of one
    // property. Something can still reclaim this lock while this process is
    // inside `body()`: since D11 that is ONLY `fleet unlock --force` (before it,
    // an invisible `age > 1h` door did it too). A second process then
    // legitimately holds `lockPath`, and an unconditional remove here would
    // delete ITS lock, handing a third process the critical section while the
    // second was still in it. The reclaim path's careful atomicity bought
    // nothing while the release could undo it.
    //
    // FENCED ON IDENTITY, and it does NOT take the file away to find out whose
    // it is. The previous shape — rename `lockPath` to a private path, read the
    // bytes, restore them if they turned out to be a successor's — was fencing
    // the DELETE while leaving the vacancy wide open, and the vacancy is the
    // defect. Between the rename and the restore there is no file at
    // `lockPath`, so a third waiter creates one legitimately; the restore then
    // fails EEXIST and the departing holder deletes the successor's captured
    // lock, leaving the successor and the third waiter both inside the critical
    // section. Not deleting the captured file would not have fixed that — by
    // then the successor's lock is already off-path and the third waiter
    // already holds `lockPath`. The rename was the bug, not the `rmSync`.
    //
    // So: ask a question that does not require possession. `wx` created this
    // file, and `fstat` on that same fd recorded its inode, so `ownIno` names
    // an object no other process can be holding. If `lockPath` still resolves
    // to it, it is ours and removing it is correct. If it resolves to anything
    // else, a reclaimer replaced us and the ONLY correct action is to touch
    // nothing at all — the successor keeps the very file it created, and the
    // path is never vacated by a non-owner.
    //
    // RESIDUAL, stated rather than glossed: a reclaim landing between the
    // `statSync` and the `rmSync` would still see us unlink a successor's lock.
    // That window is two adjacent syscalls where the old one spanned a rename,
    // a read and a write. POSIX has no unlink-if-inode primitive to close it
    // outright. Since D11 removed the age door, reaching it at all requires an
    // operator to have run `fleet unlock --force` against a LIVE holder in that
    // exact microsecond — a deliberate human override, not a timer, which is the
    // whole point of moving the escape hatch out of this loop and into a verb.
    //
    // NOTHING in this block returns or throws, and that is a correctness
    // requirement rather than a style rule. A `return` inside a `finally` is
    // read as returning `T` in this generic function AND discards whatever
    // `body()` produced; a `throw` REPLACES the exception `body()` raised, so a
    // cleanup hiccup would erase the real approval failure the caller has to
    // see. Every failure below is therefore a diagnostic, and the WORST of them
    // leaves the lock in place — which the staleness path already recovers.
    // BOTH identity and content must match, because they fail independently and
    // the conjunction is the fail-safe direction — when either says "not yours",
    // the answer is leave it alone, and a lock left standing is recovered by the
    // staleness path while a lock wrongly removed is a second process in the
    // critical section.
    //
    //  - the INODE catches replacement, which is what a real reclaim performs:
    //    it renames the old lock to a private path and then creates a fresh one
    //    with `wx`, so a successor's lock is ALWAYS a different inode. Content
    //    alone cannot see this coming, because it has to take the file away to
    //    read it.
    //  - the CONTENT catches in-place mutation, which leaves the inode intact —
    //    no code path here does that, but an operator with `echo > lock` does,
    //    and the round-6 assertion this preserves was written against exactly
    //    that shape.
    //
    // The read is second and conditional, so the ordinary release is one stat
    // and one unlink; the extra syscall is paid only by a lock that is still
    // ours by identity.
    try {
      if (statSync(lockPath).ino === ownIno && readFileSync(lockPath, "utf8") === ownContent) {
        rmSync(lockPath, { force: true });
      }
      // else: somebody else's now. Deliberately no `else` branch and no note —
      // being reclaimed mid-body is a designed outcome of the abandon door, not
      // an anomaly worth a line on every operator's stderr.
    } catch (e) {
      // ENOENT is the ordinary case, not a fault: already reclaimed and
      // released, or swept by hand. Nothing of ours is there. Anything else
      // leaves the lock where it is, so the run stays recoverable by the same
      // staleness path as a crashed holder's.
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
        noteOnStderr(
          `approval lock release: could not release ${lockPath} (${(e as Error).message}); it will be reclaimed as stale\n`,
        );
      }
    }
  }
}

/** What an operator is shown about the process that holds an approval lock. */
export interface ApprovalLockInfo {
  path: string;
  /** Age of the lock file by mtime. */
  ageMs: number;
  /** Absent when the lock's content does not begin with a parseable pid. */
  holderPid?: number;
  /**
   * `dead` — `kill(pid, 0)` said ESRCH, so the holder is provably gone and the
   * acquire loop would have reclaimed this lock by itself.
   * `alive` — the pid resolves. It may be the ORIGINAL holder or an unrelated
   * process that inherited a recycled pid; nothing on this host can tell them
   * apart, which is the whole reason this verb exists.
   * `unknown` — the lock's content carries no parseable pid (hand-edited,
   * truncated, or written by something else). Death cannot be proven either.
   * NOTE the asymmetry with the acquire loop, which is deliberate: the loop
   * reclaims a lock past `LOCK_STALE_MS` whose content is EMPTY (a stranded
   * zero-byte acquisition names no holder, so nobody can be at `body()`
   * behind it), but the verb still demands the explicit override for anything
   * that is not proof of death — an operator's force is auditable, this
   * verb's read is not, and non-empty-but-unparseable content is NOT the
   * stranded shape.
   */
  holder: "dead" | "alive" | "unknown";
}

export type ApprovalLockReclaim =
  | { outcome: "absent"; path: string }
  | ({ outcome: "reclaimed" | "refused" | "changed" } & ApprovalLockInfo);

/**
 * Inspect a run's approval lock and, when it is safe or explicitly forced,
 * remove it. The operator half of D11's decision.
 *
 * `withApprovalLock` reclaims ONLY from a provably-dead holder, which is what
 * makes its mutual-exclusion guarantee real (see its header). The cost of that
 * strictness is a wedge: a holder whose pid the OS has recycled onto some
 * unrelated live process can never be proven dead, so every approval verb for
 * that run refuses at LOCK_TIMEOUT_MS forever. This is the remedy, and it is
 * deliberately a VERB rather than a timer — an operator who has checked that no
 * reverify is running can say so, and that assertion is auditable. An `age > 1h`
 * door said it on their behalf, invisibly, and could be wrong.
 *
 * NO AUTHENTICATION, and that is not an oversight. `fleet approve` authenticates
 * because it authorizes a DECISION; this removes a lock file, and anyone who can
 * reach this directory can already `rm` it. A token check here would be theatre
 * that protects nothing and trains operators to keep a token in reach for
 * janitorial work.
 *
 * The removal is fenced on IDENTITY AND CONTENT via the same
 * rename-to-private-claim protocol the acquire loop and the teardown claim use.
 * A bare check-then-`rmSync` on the shared path has an uncloseable gap: a
 * successor can land between the re-check and the unlink, and unlinking a
 * successor's lock puts two processes in the critical section — the exact
 * defect this whole item exists to end. Renaming first makes this process the
 * only racer that can act: `rename` atomically moves WHATEVER `path` names onto
 * a private claim name no successor can take, so the removal that follows can
 * only ever unlink a file this process inspected. Re-reading inode and content
 * AT the claim proves the captured file is still the one the force decision was
 * about; on a mismatch the captured file is a live successor's, and `link`
 * restores the very inode to `path` (see the acquire loop for why link-restore,
 * never a rename-back) before the verb reports `changed`.
 */
export function reclaimApprovalLock(dir: string, runId: string, force = false): ApprovalLockReclaim {
  // Same grammar as `withApprovalLock`, and for the same reason: this builds a
  // path from `runId` and then DELETES it, so an unvalidated `../../etc/x`
  // would be an arbitrary-unlink primitive wearing a verb's name.
  assertExistingRunId(runId);
  const path = join(dir, `${runId}.approval.lock`);
  let st: ReturnType<typeof statSync>;
  let raw: string;
  try {
    st = statSync(path);
    raw = readFileSync(path, "utf8");
  } catch (e) {
    // No lock is the ordinary case and a SUCCESS: the verb's job is "this run
    // is not wedged when you are done", and it already is not.
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { outcome: "absent", path };
    throw e;
  }
  const holderPid = lockHolderPid(raw);
  const info: ApprovalLockInfo = {
    path,
    // CLAMPED at zero. `mtimeMs` is the filesystem's clock and can land a
    // fraction of a millisecond AHEAD of `Date.now()` for a file written moments
    // ago — observed at -0.85 ms on macOS — and a negative age is nonsense in a
    // field whose whole job is to help an operator decide whether to force.
    // Note this is age only, never a reclaim CONDITION: nothing here reclaims on
    // age, so clamping cannot widen anything (D11).
    ageMs: Math.max(0, Date.now() - st.mtimeMs),
    ...(holderPid === undefined ? {} : { holderPid }),
    holder: holderPid === undefined ? "unknown" : isLockHolderDead(holderPid) ? "dead" : "alive",
  };
  // `unknown` needs the override too, not just `alive`. A lock whose pid cannot
  // be read is one whose holder cannot be proven dead, and the rule this item
  // settled is that unproven death is never reclaimed implicitly.
  if (info.holder !== "dead" && !force) return { outcome: "refused", ...info };
  // Atomic claim of the suspect lock: at most one racer's rename can move
  // `path` onto this private claim name — a second racer's fails ENOENT. The
  // private name is the fence: nothing else creates it, so the reads and the
  // removal below can never race a successor onto the file they inspect.
  const claimPath = `${path}.claim.${process.pid}.${randomUUID()}`;
  try {
    renameSync(path, claimPath);
  } catch (e) {
    // It VANISHED underneath the inspection — genuinely absent now, which is
    // the healthy answer. Removing a file we did not inspect is the one thing
    // this function must never do, so a replacement (below) is reported, never
    // followed.
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    return { outcome: "absent", path };
  }
  if (statSync(claimPath).ino === st.ino && readFileSync(claimPath, "utf8") === raw) {
    // Genuinely the lock the operator's force decision was about: remove it —
    // BY ITS PRIVATE NAME, so no successor can ever be the file unlinked.
    rmSync(claimPath, { force: true });
    return { outcome: "reclaimed", ...info };
  }
  // The rename captured a SUCCESSOR's lock: the holder we inspected released
  // and a new acquisition took `path` between the inspection and the rename.
  // `absent` would be a lie an operator or script could act on — the run may
  // well be wedged on the NEW lock — so say what happened. `info` still
  // describes the lock the operator was shown, which is the one their force
  // decision was about.
  try {
    // Put the VERY FILE back — same inode, no vacancy created — so the
    // successor's content-fenced release still recognises its own lock. See
    // the acquire loop: a rename-back clobbers a third waiter that re-took
    // the path in the gap, and a rewrite mints a new inode the release
    // refuses to remove.
    linkSync(claimPath, path);
    // UNGUARDED deliberately, same asymmetry as the acquire loop: the link
    // has ALREADY succeeded, so the successor's inode is back at `path` and
    // its fenced release is safe whatever happens here. A leftover claim name
    // is a harmless second link to a file whose canonical path is correct.
    rmSync(claimPath, { force: true });
  } catch (restoreErr) {
    if ((restoreErr as NodeJS.ErrnoException).code === "EEXIST") {
      // A third waiter re-took `path` during the restore gap; its lock is the
      // live one now and the captured file is superseded. Discarding the
      // capture strands nobody: the successor's own fenced release stats the
      // inode now at `path`, sees a foreign inode, and correctly touches
      // nothing.
      rmSync(claimPath, { force: true });
    } else {
      // Filesystem fault mid-restore: fail closed — and POISON the vacant
      // `path` before surfacing. The rename-away already vacated it, and
      // rethrowing with the path still empty would let the next acquirer's
      // `wx` succeed and enter the critical section alongside the live
      // successor this capture displaced. A pid-less marker is never
      // auto-reclaimed (`lockHolderPid` → undefined fails the reclaim door),
      // so it holds the path against every later acquirer until the
      // operator's explicit `fleet unlock`. Best-effort: if the marker write
      // itself fails, the path stays VACANT — the message below names which
      // of the two states the operator is actually walking into.
      let poisoned = true;
      try {
        writeFileSync(path, `0:${randomUUID()}`, { flag: "wx", mode: 0o600 });
      } catch {
        // vacant-and-unwritable joins stranded-at-claimPath as an
        // operator-recovery state; the message below names both.
        poisoned = false;
      }
      throw new Error(
        `approval lock reclaim: failed to restore captured successor lock from ${claimPath} back to ${path}; ${
          poisoned
            ? `a poison marker now holds ${path} — inspect both by hand and recover with \`fleet unlock\``
            : `neither the captured lock nor a poison marker could be placed at ${path} — inspect both by hand and recover with \`fleet unlock\``
        }: ${(restoreErr as Error).message}`,
      );
    }
  }
  return { outcome: "changed", ...info };
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
/**
 * The ceiling the story is silent on, for `approverId` — the third free-text
 * argv value a decision writes, and the only one the story names no bound
 * for. A `reverifyId` tops out near 200 (run-record.ts's element bound) and an
 * allowlist id is operator-chosen short text, so 200 matches the file's usual
 * looser-backstop sizing rather than inventing a number.
 */
export const MAX_APPROVER_ID_CHARS = 200;

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

/**
 * The STRICT reader: a missing record throws. Used where the caller has already
 * established that the run exists and absence is therefore a broken
 * precondition, not a state — `submitDecision`'s compare-and-set and
 * `pauseRun`'s re-read under the lock.
 *
 * D4/D7 NOTE — the asymmetry with `readApprovalIfPresent` below is DELIBERATE,
 * and it was checked against the real CLI rather than reasoned about, because
 * "two readers in one module with different ENOENT postures" reads accidental.
 *
 * The concern was that `fleet approve <typo>` would surface a raw
 * `unreadable run record run-typo.json: ENOENT`. IT DOES NOT. A real
 * subprocess against a genuinely absent run exits **4** with
 * `{code: "run-not-found", message: "no run record for run-typo",
 * remediation: "check the id (fleet status) — nothing was mutated"}`, because
 * the verb block calls `assertRunExists` before it ever reaches here
 * (scripts/fleet.ts, and see `tests/fleet/gate-verbs.test.ts`'s D7 case, which
 * pins that exit code out of process so removing the guard goes red).
 *
 * So this throw is a BACKSTOP for a precondition the shipped caller
 * guarantees, and loosening it would make things worse, not better: a missing
 * record classified as `not-decidable` maps to exit **5** in the CLI, and 5
 * means "a guard fired before anything was mutated" while 4 means "that run
 * does not exist". Conflating them would answer the most ordinary operator
 * error on this verb — a typo — with the wrong code, and would erase a
 * distinction scripts/fleet.ts documents explicitly.
 *
 * The tolerant reader exists for the POLLERS, which is the real reason the two
 * differ: `sweepExpired` and `awaitDecision` observe a record repeatedly over
 * time, where absence is an ordinary observation rather than a caller error.
 */
function readApproval(store: RunRecordStore, runId: string): ExtensionEntry | undefined {
  return store.get(runId).extensions?.approval;
}

/**
 * The TOLERANT reader, for callers that POLL. ENOENT ⇒ no such run, the
 * `stampFanoutExtension` idiom. Everything else throws. See `readApproval`
 * above for why the two postures differ on purpose.
 */
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
  // Type-guard rather than `String()`-coerce: the store's `strings` kind
  // rejects non-strings on the way in, so a non-string here can only be a
  // hand-edited record — and coercing that to text puts `[object Object]`
  // into an append-only audit trail as if it were a reportId ever bound.
  // Skipping the element keeps the trail provably wrong rather than
  // plausibly wrong; `superseded`'s dedupe below never re-adds it.
  return Array.isArray(raw) ? raw.filter((id): id is string => typeof id === "string") : [];
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
 * INV-APPROVE-6 on EVERY route to the decidable window, not only the promote
 * tail. The promote tail enforces the invariant when `requestApproval` first
 * lifts a record to `awaiting-approval`, but two later routes also make — or
 * keep — a run decidable without ever reaching that tail: the rebind, which
 * refreshes the window on a record that is already decidable, and
 * `submitDecision`, which writes the authorizing record itself. A stranded
 * record can pick up a live box AFTER its window opened (a hand-edit, an
 * external teardown that reopened nothing but also cleared nothing); rebind or
 * decide there and the gate would hand an approver an authorization sitting
 * over live, billing infrastructure — the exact coexistence INV-APPROVE-6
 * forbids, reached through the door the promote tail does not cover.
 *
 * Unlike the promote tail, this guard takes NO `teardown === undefined`
 * condition: neither route runs a teardown of its own, so a seam's presence
 * buys nothing here. `closedAt` is the record settling the "already gone"
 * claim, exactly as on the promote tail; fail-safe direction is refuse.
 */
function refuseLiveInfraOnDecidable(runId: string, rec: RunRecord, verb: string): void {
  if (rec.closedAt !== undefined) return;
  if (rec.vmName === undefined && rec.keyHash === undefined) return;
  const what =
    rec.vmName === undefined
      ? "a minted key"
      : `box ${rec.vmName}${rec.keyHash === undefined ? "" : " and its minted key"}`;
  throw new Error(
    `refusing to ${verb} ${runId}: its record is open and still names ${what}, so the approval window would sit over live infrastructure — run \`fleet teardown ${runId}\` first`,
  );
}

/**
 * The pause's sub-timings, accumulated as the call proceeds.
 *
 * `record_write_ms` is the time spent in `store.set` for THIS call — the same
 * meaning `run-record.ts`'s own `record_write_ms` carries — summed across the
 * one or two writes a pause performs (register, then promote).
 *
 * `teardown_at_pause_ms` is present ONLY when `deps.teardown` actually ran.
 * Absence means no teardown was owed at this gate, which is the normal shipped
 * case: `reverify()` is host-side out-of-box and runs AFTER DF2.5 has already
 * torn the box down, so the port it builds carries no teardown seam and there
 * is nothing here to measure (see deferred item D8). Emitting `0` instead would
 * be a lie shaped exactly like an instantaneous teardown.
 */
interface PauseTimings {
  record_write_ms: number;
  teardown_at_pause_ms?: number;
}

/**
 * What the pause learns about itself as it runs, so the `finally` in
 * `requestApproval` can emit ONE line describing what really happened.
 *
 * Mutable and threaded rather than derived at the end: `state` is the state the
 * RECORD holds, and only the code at each exit knows it — the promote step can
 * find the record already moved by a concurrent resume, and a throw mid-pause
 * leaves `pausing` on disk. Re-reading the record from the `finally` would be
 * both an extra read and a different instant.
 */
interface PauseCtx {
  startedAt: number;
  timings: PauseTimings;
  /** The RUN's dispatch correlation id, once a record has been read. */
  dispatchRequestId?: string;
  /** "unknown" until a record has been read — never a guessed state. */
  state: string;
  /** "error" until an exit sets it — so a throw needs no catch to be reported. */
  outcome: string;
}

/**
 * One structured line per gate event — the story's Observability Contract:
 * `{requestId, runId, event, state, approverId?, durationMs, outcome}`.
 *
 * This is the MIRROR of `scripts/fleet.ts`'s `gateEvent`, which produces every
 * other member of that event union (`approve`, `reject`, `timeout`, `refused`,
 * `attach`). `pause` cannot come from there: `requestApproval` has zero call
 * sites in the CLI — the pause happens inside reverify
 * (`src/reverify/runner.ts`'s `port.requestApproval`) — so this function is its
 * producer, and `tests/fleet/verbs.test.ts` pins that every declared member has
 * one.
 *
 * TWO correlation ids under TWO keys, because they are two different facts and
 * one key holding both is the correlation bug `scripts/fleet.ts` names at its
 * attach completion line:
 *
 *  - `requestId` is the EMITTING context's own id. Here that IS the run's
 *    dispatch id, because the gate is a library call with no invocation of its
 *    own and `src/reverify/runner.ts` already stamps exactly that value on
 *    every step line it emits around this one — so the pause line correlates
 *    with its neighbours in the same stream.
 *  - `dispatchRequestId` is the RUN's dispatch id under the key EVERY gate
 *    event carries it under, and it is the join DF5.3 performs across
 *    processes. On this line the two coincide; on the CLI's lines they do not,
 *    which is precisely why the join needs its own key instead of `requestId`.
 *
 * `status: "ok"` means the call RETURNED. The CLI's rule is "the invocation
 * exits 0" and the gate has no exit code, but it draws the same line:
 * `pause-in-progress` and `already-decided` are answers reverify flags onto the
 * report and continues from, while a throw is what becomes
 * `approval-request-failed` there.
 *
 * NO SECRETS. Every field is an id, a state word or a duration — the proposal,
 * the reason and the approver's token never reach it, and the two ids go
 * through the same `boundedEcho` (redact-then-cap) the CLI echoes ids with.
 * `outcome: "error"` deliberately carries NO error message: the messages thrown
 * here name `vmName`, `bundleDir` and record fields, and the operator already
 * receives the text through reverify's own `step("approval", …)` line.
 *
 * Guarded, like every other emitter in the fleet: a raising sink must never
 * replace the gate's real outcome.
 */
function emitPause(ctx: PauseCtx, runId: string): void {
  try {
    const durationMs = Date.now() - ctx.startedAt;
    const dispatch = ctx.dispatchRequestId === undefined ? undefined : boundedEcho(ctx.dispatchRequestId);
    log({
      // "unknown", never a freshly minted id: a random correlation id joins to
      // nothing and looks exactly like one that does. `runner.ts` uses the same
      // word for the same missing field.
      requestId: dispatch ?? "unknown",
      operation: "fleet.pause",
      agentId: null,
      timestamp: new Date().toISOString(),
      duration: durationMs,
      durationMs,
      status: ctx.outcome === "error" ? "error" : "ok",
      runId: boundedEcho(runId),
      event: "pause",
      state: ctx.state,
      outcome: ctx.outcome,
      ...(dispatch === undefined ? {} : { dispatchRequestId: dispatch }),
      ...ctx.timings,
    });
  } catch {
    // A diagnostic is never the gate's outcome.
  }
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
  // The `pause` gate event is emitted from a `finally`, so EVERY exit — all
  // four outcomes and every throw — produces exactly one line, and no future
  // return path can be added that silently produces none. That is the whole
  // defect being fixed here (a declared event with no producer), so the
  // producer is placed where forgetting it is not an option.
  const ctx: PauseCtx = { startedAt: Date.now(), timings: { record_write_ms: 0 }, state: "unknown", outcome: "error" };
  try {
    return await pauseRun(deps, runId, req, ctx);
  } finally {
    emitPause(ctx, runId);
  }
}

/**
 * `requestApproval`'s body. Split out only so the wrapper above can own the
 * `finally` — this is the pause, and everything the story's AC1 says about
 * ordering is here.
 */
async function pauseRun(deps: GateDeps, runId: string, req: ApprovalRequest, ctx: PauseCtx): Promise<ApprovalOutcome> {
  const timings = ctx.timings;
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
  // diagnostic with a `TypeError` naming nothing. LOWER-CASED before the
  // regex: git emits hex lower-case, but a caller that round-tripped the sha
  // through something that upper-cased it (`git log --pretty=... | tr`, a JSON
  // tool's default) is naming the same commit, and HEAD_SHA_RE's own test pins
  // that a legit 40-hex sha binds. The STORED form stays whatever arrived —
  // every comparison against it (`submitDecision`'s reportId CAS, DF5.2's
  // push-side recheck) is against the record's own field, never re-derived
  // here, so normalizing at the door is the one place it can be done without
  // splitting the case across two stores of truth.
  const headSha = String(req.headSha ?? "")
    .trim()
    .toLowerCase();
  if (!HEAD_SHA_RE.test(headSha)) {
    throw new Error(`approval requires a 40-hex headSha, got ${JSON.stringify(headSha.slice(0, 64))}`);
  }

  const store = deps.store;
  // Pre-lock clock read, kept for the expiry EVALUATION below: the rebind arm
  // compares the record's `expiresAt` against the instant this call arrived,
  // so a lock wait must not extend the window a competing decision was
  // measured against. The STAMPS are re-read inside the lock (see there) so a
  // call that waited out the lock does not write timestamps minutes old.
  const at = nowOf(deps);
  const proposal = capText(String(req.proposal ?? ""), MAX_PROPOSAL_CHARS);

  // `promote` marks the two entries that still owe the tail below (guards →
  // teardown → promotion): a fresh registration, and a resume of a `pausing`
  // record this same report already owns.
  const transition = await withApprovalLock(store.dir, runId, (): ApprovalOutcome & { promote?: true } => {
    // Clock read AFTER the lock: `withApprovalLock` can wait up to
    // LOCK_TIMEOUT_MS, and stamps taken before it can land minutes in the
    // past — a `requestedAt` older than the record's own `decidedAt`, or a
    // `decidedAt`/`expiresAt` pair that disagrees with the moment the write
    // really happened. One read, then both stamps derive from it, so the pair
    // stays monotonic.
    const lockedAt = nowOf(deps);
    const requestedAt = lockedAt.toISOString();
    // Stamped on EVERY write of the pair, never on the first alone: `set()`
    // merges field-by-field, so a rebind that refreshed `requestedAt` and left
    // `expiresAt` behind would inherit whatever remained of the original
    // window — a report bound at T+23h59m would time out a minute later,
    // against a record whose own two timestamps contradict each other.
    const expiresAt = new Date(lockedAt.getTime() + resolveTimeoutMs(deps)).toISOString();
    const rec = store.get(runId);
    // The RUN's dispatch correlation id — the cross-process join key every gate
    // event carries (see `emitPause`) and the value stamped onto
    // `extensions.approval.requestId` at every write below, so a record whose
    // top-level field a later reader cannot see still joins. Captured here
    // because this is the first record read on every path that gets past the
    // lock.
    ctx.dispatchRequestId = rec.requestId;
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
      // Same fail-closed guard as the fresh-register and rebind paths: a
      // resume is the THIRD route to the decidable state, and a report naming
      // a run whose bundle is gone is bound to nothing on any of them.
      assertBundlePresent(deps, runId, "resume");
      // Restamp the window BEFORE promoting, BOTH fields together. The record
      // may have sat in `pausing` long past its original deadline — that is
      // the ordinary case, since `pausing` is what a crashed teardown leaves
      // behind — and `set()` merges field-by-field, so promoting with the
      // stale stamps would produce an `awaiting-approval` record whose
      // `expiresAt` is already past: instantly `timed-out` on the first
      // read, against a run that was never awaiting anybody. The promotion
      // below is the only OTHER mutation a resume makes.
      const tRestamp = Date.now();
      store.set(runId, {
        extensions: {
          approval: {
            requestedAt,
            expiresAt,
            // Restamped too: a resume must keep the correlation id it was
            // registered with, or the record's own join key could go stale.
            ...(ctx.dispatchRequestId === undefined ? {} : { requestId: ctx.dispatchRequestId }),
          },
        },
      });
      timings.record_write_ms += Date.now() - tRestamp;
      return { outcome: "requested", promote: true };
    }
    // Expiry is applied to the READ, so a rebind arriving after `expiresAt`
    // sees `timed-out` and loses exactly as it would against a real decision.
    const effective = state === undefined ? undefined : expiredState(existing, at);
    if (effective !== undefined && TERMINAL.has(effective)) return { outcome: "already-decided", state: effective };

    if (effective === "awaiting-approval") {
      assertBundlePresent(deps, runId, "rebind");
      // INV-APPROVE-6 on the rebind arm too. A rebind REFRESHES the window on
      // a record that is about to become (or remain) decidable, so it may not
      // extend an approval window over live infrastructure any more than the
      // promote tail may create one: an open record still naming a `vmName` is
      // a live, billing box, and a record naming `keyHash` while still open is
      // a key that may still be live. The guards run BEFORE the restamp so a
      // refused rebind leaves the old window standing rather than a fresh one
      // over the box.
      refuseLiveInfraOnDecidable(runId, rec, "rebind");
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
      const tRebind = Date.now();
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
            // The dispatch id rides EVERY full-shape write, so a rebind keeps
            // the join key current — a reader that resolves the record's
            // extension field never meets a stale one.
            ...(ctx.dispatchRequestId === undefined ? {} : { requestId: ctx.dispatchRequestId }),
          },
        },
      });
      timings.record_write_ms += Date.now() - tRebind;
      return { outcome: "rebound", supersededReportId };
    }

    assertBundlePresent(deps, runId, "pause");
    // (a) EVIDENCE FIRST. `pausing` is on disk before anything irreversible.
    const tRegister = Date.now();
    store.set(runId, {
      extensions: {
        approval: {
          state: "pausing",
          proposal,
          reportId,
          headSha,
          // The run's dispatch id, stamped into the extension so the record's
          // approval evidence carries its own join key — a reader resolving
          // `extensions.approval.requestId` (the CLI's fallback when the
          // top-level field is absent) finds the dispatch id the pause ran
          // under, not a field that can never be set.
          ...(ctx.dispatchRequestId === undefined ? {} : { requestId: ctx.dispatchRequestId }),
          requestedAt,
          expiresAt,
          // Explicit, never left to a deep-merge: `set()` merges field-by-field,
          // so an omitted key retains whatever an earlier cycle left there.
          supersededReportIds: [],
        },
      },
    });
    timings.record_write_ms += Date.now() - tRegister;
    return { outcome: "requested", promote: true };
  });

  if (transition.promote !== true) {
    const { promote: _promote, ...answer } = transition;
    ctx.outcome = answer.outcome;
    // The state the RECORD is in, per outcome: `already-decided` carries the
    // terminal state it found, `pause-in-progress` means the record is `pausing`
    // under a different report, and `rebound` re-bound an `awaiting-approval`
    // record and left it there.
    ctx.state =
      answer.outcome === "already-decided"
        ? answer.state
        : answer.outcome === "pause-in-progress"
          ? "pausing"
          : "awaiting-approval";
    return answer;
  }
  // Past the lock and owing the tail: the record says `pausing` on disk right
  // now. A throw below (either fail-closed refusal, or teardown itself) leaves
  // it there, which is the designed recoverable state — and the state the event
  // line must report for those throws.
  ctx.state = "pausing";

  // R5-C, DF3.1's posture translated: a box with no `keyHash` on an OPEN record
  // is the mint's crash window — a key may be live and billing with nothing
  // pointing at it. `fleet teardown` can only exit 6 about this because the box
  // is already gone by then; here we are BEFORE teardown, so refusing is
  // available and strictly better. The `pausing` extension written above stands,
  // so the run stays recoverable and the refusal is auditable.
  const rec = store.get(runId);
  if (rec.vmName !== undefined && rec.keyHash === undefined && rec.closedAt === undefined) {
    throw new Error(
      `refusing to pause ${runId}: it has a box (${rec.vmName}) but no keyHash, so a minted key may still be live and this pause cannot revoke it — check the provider's key list for one created around ${rec.createdAt}. The key-ledger gap is the blocker, not a crashed pause: the record stays \`pausing\` and re-running reverify re-refuses here until the key is accounted for`,
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
      `refusing to pause ${runId}: its record is open and still owns box ${rec.vmName}, but no teardown seam was provided, so this pause cannot destroy it and would promote a decidable run over a live box — call the gate from a caller that passes GateDeps.teardown, or run \`fleet teardown ${runId}\` first. The live box is the blocker, not a crashed pause: the record stays \`pausing\` and re-running reverify re-refuses here until the box is destroyed`,
    );
  }

  // (b) Teardown, OUTSIDE the lock. A throw here leaves `pausing` on disk,
  // which is the designed recoverable state — never a swallowed failure.
  // Re-run unconditionally on a resume: DF2.5 makes it idempotent, and the
  // reason we are here at all is that the last attempt may not have finished.
  if (deps.teardown !== undefined) {
    // Timed only when the seam EXISTS. `teardown_at_pause_ms` is absent — not
    // zero — when no teardown was owed, so the field's presence means a real
    // teardown ran at the gate rather than "we measured nothing and called it
    // instant". See `PauseTimings`.
    const tTeardown = Date.now();
    await withTeardownClaim(store.dir, runId, deps.teardown);
    timings.teardown_at_pause_ms = Date.now() - tTeardown;
  }

  // (c) Promote, and only from `pausing`: re-read under the lock rather than
  // trusting the state this call observed minutes ago.
  const promoted = await withApprovalLock(store.dir, runId, (): boolean => {
    const current = String(readApproval(store, runId)?.state ?? "");
    if (current !== "pausing") {
      // A concurrent resume promoted it, or the record moved underneath us.
      // The line must report the state that is really there rather than the
      // transition this call did not make — and the OUTCOME must not claim a
      // promotion it skipped (finding 4, round 7): `pause-in-progress` is the
      // port member for "this call left the record undecidable", which is what
      // losing the promote race means. runner.ts flags it and re-presents the
      // bound reportId, which re-runs the pause against the state the winner
      // actually left — never a dead end, and never a false `requested`.
      ctx.state = current === "" ? "unknown" : current;
      ctx.outcome = "pause-in-progress";
      return false;
    }
    const tPromote = Date.now();
    store.set(runId, { extensions: { approval: { state: "awaiting-approval" } } });
    timings.record_write_ms += Date.now() - tPromote;
    ctx.state = "awaiting-approval";
    return true;
  });
  ctx.outcome = promoted ? "requested" : "pause-in-progress";
  return promoted ? { outcome: "requested" } : { outcome: "pause-in-progress" };
}

/**
 * ONE teardown at a time per run, across CONCURRENT RESUMES.
 *
 * The approval lock is deliberately NOT held across teardown (seconds to
 * minutes against a 5 s wait ceiling), so two same-reportId resumes of one
 * `pausing` record — the runner retrying a crashed pause in two processes at
 * once — both pass the transition and the guards and would otherwise run
 * `deps.teardown` CONCURRENTLY. DF2.5 makes the sandbox side idempotent, but
 * its `pullArtifacts` step is not: it writes fixed shared host paths, and two
 * pulls racing on them interleave. This claim is the fence: the first resume
 * takes it, a concurrent one WAITS and then runs its own teardown (idempotent
 * — re-running is exactly what a resume is for), and a claim whose pid is
 * dead is reclaimed so a crashed teardown never wedges the resume.
 *
 * Reclaiming here is NOT the approval lock's unproven-death rule, and the
 * difference is the failure direction: wrongly reclaiming an approval lock
 * breaks mutual exclusion, while wrongly reclaiming THIS claim degrades to a
 * concurrent teardown — the pre-claim status quo, never worse. So a claim
 * with an unparseable or dead pid is fair game — but ONLY once it has age,
 * because a claim with no pid yet is one this loop is mid-write on: the `wx`
 * opens the file BEFORE `writeFileSync` lands the content, so another waiter
 * can observe EEXIST against an empty file whose holder pid it can never
 * read. Reclaiming that instantly destroys a lock the moment it was taken.
 * Age past LOCK_STALE_MS is the same door the approval lock uses, and at that
 * age the writer is provably gone (the guarded body outlives the timeout by
 * construction — see LOCK_STALE_MS).
 *
 * THE WAIT IS BOUNDED. A live holder wedged forever, or a claim whose pid the
 * OS has recycled onto an unrelated process, would otherwise spin a resume
 * indefinitely. At CLAIM_TIMEOUT_MS the waiter throws naming the claim path
 * and the operator remedy — the same posture as the approval lock's own
 * timeout, minus the `fleet unlock` verb: the resume that hits this is
 * re-runnable, and a crashed teardown leaves `pausing` on disk (AC1(c)),
 * which is already the recoverable state.
 *
 * The release is fenced on CONTENT (this call's nonce), not taken
 * unconditionally: a claim reclaimed underneath a slow teardown belongs to
 * its new owner, and removing it would re-open the concurrency this fence
 * exists to close.
 */
async function withTeardownClaim(
  dir: string,
  runId: string,
  teardown: (runId: string, opts: { noHarvest: true }) => Promise<void>,
): Promise<void> {
  const claimPath = join(dir, `${runId}.teardown.claim`);
  const own = `${process.pid}:${randomUUID()}`;
  const deadline = Date.now() + CLAIM_TIMEOUT_MS;
  for (;;) {
    try {
      writeFileSync(claimPath, own, { flag: "wx", mode: 0o600 });
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      // ONE door: proof of death, with age as a PRECONDITION for looking — the
      // approval lock's rule, cheapened only in the failure direction. Age
      // first means a fresh claim is never even inspected, so the no-content
      // window between `wx` and the content write is never mistaken for a dead
      // holder. Past LOCK_STALE_MS, a missing or dead pid both reclaim: this
      // fence's failure direction makes that safe (see the header).
      //
      // THE RECLAIM ITSELF mirrors the approval lock's, not for style but
      // because a bare read-then-`rmSync` re-opens the race it closed: a
      // second waiter can re-take `claimPath` between this waiter's read and
      // its unlink, and the unlink would then destroy a LIVE holder's claim —
      // the fence would leak exactly the concurrent teardown it exists to
      // prevent. Renaming the suspect claim to a private path first means the
      // winner of the rename is the only racer that can act, and re-reading the
      // content AT the private path proves the file this waiter is about to
      // delete is still the one it judged dead. On a mismatch the captured file
      // is a live replacement's, and `link` puts the very inode back — see the
      // approval-lock block for why link-restore, never a rename-back: a
      // rename-back clobbers a third waiter that re-took the path in the gap.
      let holderLooksLive = true;
      let holderPid: number | undefined;
      try {
        const age = Date.now() - statSync(claimPath).mtimeMs;
        if (age > LOCK_STALE_MS) {
          const raw = readFileSync(claimPath, "utf8");
          holderPid = lockHolderPid(raw);
          if (holderPid === undefined || isLockHolderDead(holderPid)) {
            // Atomic claim of the claim: at most one racer's rename can move
            // `claimPath` aside — a second racer's fails ENOENT and retries
            // the `wx` against whatever the winner leaves behind.
            const stealPath = `${claimPath}.reclaim.${process.pid}.${randomUUID()}`;
            let stolen = false;
            try {
              renameSync(claimPath, stealPath);
              stolen = true;
            } catch (renameErr) {
              if ((renameErr as NodeJS.ErrnoException).code !== "ENOENT") throw renameErr;
            }
            if (stolen) {
              if (readFileSync(stealPath, "utf8") === raw) {
                // Genuinely the dead holder's claim: remove it and re-take.
                rmSync(stealPath, { force: true });
                holderLooksLive = false;
              } else {
                // A live replacement re-took the path between the read and
                // the rename. Restore the VERY FILE — same inode, no vacancy
                // created — so its owner's content-fenced release still
                // recognises it, then wait like any other live holder.
                try {
                  linkSync(stealPath, claimPath);
                } catch (linkErr) {
                  // EEXIST: a new holder re-took the path during the gap; its
                  // claim is the live one now and the captured file is
                  // superseded. Anything else is a filesystem fault: rethrow —
                  // the resume fails loudly instead of racing a holder we can
                  // no longer account for — and the captured file stays at
                  // `stealPath` (a later waiter reclaims it stale, same as any
                  // crashed claim). The path MAY be vacant while the fault is
                  // surfacing, which this fence already prices: a wrongly
                  // vacant claim degrades to concurrent teardown, the
                  // pre-claim status quo, never worse (see the header).
                  if ((linkErr as NodeJS.ErrnoException).code !== "EEXIST") throw linkErr;
                }
                rmSync(stealPath, { force: true });
              }
            }
          }
        }
      } catch (readErr) {
        // Vanished between the EEXIST and the stat/read — including a rename
        // won by a concurrent reclaimer. Fall through to the deadline check
        // and sleep below — same reasoning as the approval lock: skipping them
        // turns contention into a busy-spin.
        if ((readErr as NodeJS.ErrnoException).code !== "ENOENT") throw readErr;
        holderLooksLive = false;
      }
      if (holderLooksLive) {
        // A live holder is mid-teardown right now. Wait for it rather than
        // racing its `pullArtifacts` on the same host paths.
        if (Date.now() >= deadline) {
          throw new Error(
            `approval teardown claim ${claimPath} still held after ${CLAIM_TIMEOUT_MS}ms (holder pid ${holderPid ?? "unreported"}); a live teardown does not run this long — check for a sandbox-teardown process, remove ${claimPath} only if none is running, then re-run the resume`,
          );
        }
        await Bun.sleep(LOCK_POLL_MS);
      }
    }
  }
  try {
    await teardown(runId, { noHarvest: true });
  } finally {
    try {
      if (readFileSync(claimPath, "utf8") === own) rmSync(claimPath, { force: true });
    } catch (e) {
      // ENOENT is ordinary (hand-swept, or reclaimed and released by a waiter).
      // Anything else leaves the claim standing, which the pid-liveness
      // reclaim above recovers once this process exits.
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
        noteOnStderr(
          `approval teardown claim: could not release ${claimPath} (${(e as Error).message}); it will be reclaimed once this process exits\n`,
        );
      }
    }
  }
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
  // Capped like `reason` — this field lands in a TERMINAL record, so it is the
  // one approval field with no later write to correct it, and an unpinned
  // `--approver` value is argv an operator does not control the length of. The
  // cap rides the constant discipline the other caps set: the bound is a named
  // contract, not a magic number at the call site.
  const cappedApproverId = capText(approverId, MAX_APPROVER_ID_CHARS);

  const store = deps.store;
  // Pre-lock clock read, kept for the expiry EVALUATION below: the decision is
  // judged against the instant the caller arrived, so a lock wait must not
  // push a decision past its own deadline. `decidedAt` is re-read inside the
  // lock (see there) so the terminal record carries the moment the write
  // really happened.
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
      writeTimeout(store, runId, existing);
      return { outcome: "already-decided", ...decisionOf(readApproval(store, runId)) };
    }
    if (effective !== undefined && TERMINAL.has(effective)) {
      return { outcome: "already-decided", ...decisionOf(existing) };
    }
    if (effective !== "awaiting-approval") return { outcome: "not-decidable", state: String(existing.state ?? "") };

    // The decision side of the bundle invariant. `requestApproval` checks the
    // bundle on pause, rebind AND resume; nothing about a human decision is
    // slower than a rebind, and the record `submitDecision` writes is exactly
    // the one DF5.2 reads to authorize a PR — so an approval granted over a
    // bundle that no longer exists is refused here, at the last moment it can
    // be. The verb tag matches the other two call sites' style.
    assertBundlePresent(deps, runId, "decide");

    // The decision side of INV-APPROVE-6. The record this call writes IS the
    // authorization, so it refuses one over live infrastructure for the same
    // reason it refuses one over a missing bundle — and unlike the promote
    // tail, no teardown runs anywhere near this arm for a seam to excuse.
    refuseLiveInfraOnDecidable(runId, store.get(runId), "decide");

    // Trimmed on both sides of the compare-and-set, matching what
    // `requestApproval` bound — otherwise a `$(...)`-captured id with a
    // trailing newline is answered `report-changed` against the id it IS.
    const bound = String(existing.reportId ?? "");
    if (bound !== String(req.reportId ?? "").trim()) return { outcome: "report-changed", reportId: bound };

    // Host clock, read INSIDE the lock — the same re-stamp `pauseRun` does: a
    // decision that waited out a contended lock must record the moment it
    // decided, not the moment it arrived. Necessarily after the report it
    // authorizes: the report completed before `requestApproval` ran. DF5.2
    // refuses `approval-precedes-report` on a stamp older than
    // `report.completedAt`, and `approval-incomplete` if either this or
    // `approverId` is missing — so both are written here or neither is
    // (push.ts:257-299).
    const decidedAt = nowOf(deps).toISOString();
    store.set(runId, {
      extensions: {
        approval: {
          state: req.decision,
          approverId: cappedApproverId,
          decidedAt,
          reason: capText(String(req.reason ?? ""), MAX_REASON_CHARS),
        },
      },
    });
    return { outcome: "decided", state: req.decision, approverId: cappedApproverId, decidedAt };
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

function writeTimeout(store: RunRecordStore, runId: string, ext: ExtensionEntry): void {
  store.set(runId, {
    extensions: {
      approval: {
        state: "timed-out",
        approverId: TIMEOUT_APPROVER_ID,
        // The expiry INSTANT, not the moment this writer noticed — the SAME
        // anchor `derivedTimeout` reports. The clock passing `expiresAt` is
        // what decided this, and a persisted record stamped at notice-time
        // would contradict the answer a status reader gave a minute earlier
        // for the same decision. `expiresAt` is necessarily parseable here:
        // `expiredState` only returns `timed-out` when it is finite.
        decidedAt: String(ext.expiresAt ?? ""),
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
    writeTimeout(store, runId, existing);
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
  const requestedPoll = opts.pollMs ?? 1_000;
  // CLAMPED, never refused — the `resolveTimeoutMs` posture. A zero or
  // negative interval makes `Bun.sleep` a no-op and turns this loop into a
  // synchronous busy-spin against the filesystem for up to `waitMs` (24h by
  // default); a non-finite one sleeps forever. The floor is the lock's own
  // poll interval: sub-10ms polling buys nothing at human decision speed.
  const pollMs = !Number.isFinite(requestedPoll) ? 1_000 : Math.max(requestedPoll, LOCK_POLL_MS);
  // The deadline gets the SAME clamp as the interval above (a NaN/Infinity
  // `waitMs` makes `deadline` non-finite, and `Date.now() >= Infinity` is
  // false forever — the caller's own window silently becomes "never").
  // A negative one fires instantly and answers `null` without a poll, which is
  // the honest reading of "wait zero": reported, not silent.
  const requestedWait = opts.waitMs ?? DEFAULT_TIMEOUT_MS;
  const waitMs = Number.isFinite(requestedWait) ? Math.max(requestedWait, 0) : DEFAULT_TIMEOUT_MS;
  const deadline = Date.now() + waitMs;
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
