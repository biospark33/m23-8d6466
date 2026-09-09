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
 * has nothing to destroy — but an OPEN record still naming a `vmName`, or a
 * minted `keyHash` with no box name left, is the
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
 *    a stored copy against a recomputed one is vacuous. Existence (and
 *    non-emptiness — a zeroed file is not a bundle) is the stronger check and
 *    is what `deps.bundleDir` enables.
 *
 * THE LOCK IS NEVER HELD ACROSS TEARDOWN. Teardown is seconds to minutes;
 * `withApprovalLock` times out at LOCK_TIMEOUT_MS and would refuse every
 * concurrent verb for the duration. It is taken for the state transition,
 * released, teardown runs, and it is retaken to promote.
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
 * ponytail: spin-wait with a fixed 10 ms poll and a 15 s ceiling. Two concurrent
 * reverifies of one run is the worst realistic contention; swap for a proper
 * wait queue if that stops being true.
 */
/**
 * WHY 15 s and not less: `RunRecordStore.set` takes its own private record lock
 * (`LOCK_TIMEOUT_MS`, run-record.ts) and waits that out with a BLOCKING
 * `Atomics.wait`, so a LIVE gate holder can be stalled for up to 5 s on the
 * store's clock without being dead in any sense. A timeout at or under 5 s
 * declares that holder wedged and tells the operator to `fleet unlock` a lock
 * somebody is actively holding. Three times the store's worst case leaves
 * margin for scheduling jitter without letting a genuinely recycled pid wedge
 * much longer than before.
 */
const LOCK_TIMEOUT_MS = 15_000;
const LOCK_POLL_MS = 10;
/**
 * Age at which a lock is assumed abandoned. DELIBERATELY past the wait timeout:
 * at exactly `LOCK_TIMEOUT_MS` a waiter would steal every lock the instant it
 * gave up waiting, which is not a stale-lock recovery, it is no lock at all.
 * The guarded body is one read-decide-write, so a live holder never reaches
 * `LOCK_STALE_MS`.
 */
const LOCK_STALE_MS = 2 * LOCK_TIMEOUT_MS;

/**
 * How long a `withTeardownClaim` waiter waits for a live holder before
 * refusing. Teardown scale, NOT lock scale: a claim is legitimately held for
 * the whole of a teardown, which the module header puts at "seconds to
 * minutes", so this inherits the fleet's teardown ceiling
 * (`LOSER_TEARDOWN_TIMEOUT_MS`, fanout-primitive.ts) rather than the lock's
 * LOCK_TIMEOUT_MS, which a real teardown blows through every time.
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
  // Actual time spent asleep, accumulated across the loop. Belt-and-braces with
  // the wall-clock `deadline` below: a backward clock step (NTP correction, a
  // resumed laptop) makes `Date.now() >= deadline` false forever, and a
  // wall-only gate would then spin past its own budget indefinitely. Sleeping
  // is the only thing this loop waits on, so accumulated sleep is a lower bound
  // on real elapsed time — it can fire a little LATE (loop work is uncounted),
  // never early, which is the safe direction for a lock wait.
  let sleptMs = 0;
  for (;;) {
    try {
      // `openSync` + `fstatSync` rather than `writeFileSync` + `statSync`:
      // `wx` creates atomically, and fstat on OUR OWN fd reports the inode of
      // the file THIS call created with no window in which a replacement could
      // be measured instead. Recording the inode by `statSync(lockPath)` after
      // the write could measure a replacement's file as ours, and the release
      // would then refuse to remove our own lock. (The re-verify below DOES
      // stat the path afterwards — but only to COMPARE against the fd's inode,
      // never to record it.)
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
        // Fenced on the fd's own inode versus the PATH, not on `ownIno`:
        // `ownIno` is still -1 here by construction (it is only recorded after
        // the write succeeds), so the old `ownIno === -1 ||` guard was a
        // constant TRUE, and the cleanup unlinked whatever sat at `lockPath`.
        // And "nothing else can be at `lockPath`" is false in exactly the
        // suspended-writer shape this loop already handles below: this process
        // can be suspended between the `wx` open and this write for longer
        // than LOCK_STALE_MS, a waiter reclaims the EMPTY lock by right, and a
        // successor re-takes the path before our write fails. Removing by path
        // then deletes the SUCCESSOR's lock — two processes in the critical
        // section. `statSync(lockPath)` against the fd's inode answers "is the
        // file at the path still the one THIS fd created"; on a mismatch (or a
        // vanished path, the same fact) remove nothing. Leaving a lock that is
        // ours is recovered by the stale door below; removing a successor's is
        // not recoverable by anything.
        try {
          if (statSync(lockPath).ino === fstatSync(fd).ino) rmSync(lockPath, { force: true });
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
      // RE-VERIFY IDENTITY THROUGH THE PATH before believing the acquisition.
      // The content write above is not atomic with the `wx` open: this process
      // can be suspended between the two for longer than LOCK_STALE_MS, and a
      // waiter that then reads an EMPTY lock past the stale window reclaims it
      // by right (a lock naming no holder can never name a live one — it had no
      // way to know this holder was merely paused mid-write). Its rename and
      // unlink leave THIS fd pointing at an unlinked inode, and `fstatSync(fd)`
      // above happily reports that inode — so without this check the loop would
      // break into `body()` beside the waiter: two processes in the critical
      // section. `statSync(lockPath)` answers the only question that matters —
      // does the PATH still resolve to the file THIS call created? A mismatch,
      // or a throw (the same fact reached through a vanished path), means
      // somebody else owns it now. Nothing is removed here: the fenced release
      // would have refused anyway, and the successor's lock is exactly what
      // must survive.
      let stillOurs = false;
      try {
        stillOurs = statSync(lockPath).ino === ownIno;
      } catch {
        stillOurs = false;
      }
      if (!stillOurs) {
        // Lost the race. `ownIno` names the UNLINKED file and would poison the
        // write-failure cleanup on a later iteration (it would refuse to remove
        // a lock that IS ours), so drop it — and surface the loss as the EEXIST
        // the catch below already understands, so the loss waits out the lock
        // like any other contention instead of skipping the deadline check.
        ownIno = -1;
        throw Object.assign(
          new Error(`approval lock ${lockPath}: the empty lock this call created was reclaimed before its content landed`),
          { code: "EEXIST" },
        );
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
                // Genuinely the dead holder's lock: reclaim it. A fault in this
                // unlink leaves `lockPath` VACANT (the rename-away above) with
                // the dead lock stranded at `claimPath` — poison the vacancy
                // before surfacing, the same posture as the restore arm below,
                // so the operator inherits a HELD path with a named remedy
                // rather than a silent vacancy and a raw EACCES naming only the
                // private claim path. The holder was provably dead, so nothing
                // is displaced and no exclusion is broken; the marker is the
                // signal, not the safety.
                try {
                  rmSync(claimPath, { force: true });
                } catch (reclaimErr) {
                  let poisoned: "placed" | "held" | "failed" = "placed";
                  try {
                    writeFileSync(lockPath, `0:${randomUUID()}`, { flag: "wx", mode: 0o600 });
                  } catch (poisonErr) {
                    poisoned = (poisonErr as NodeJS.ErrnoException).code === "EEXIST" ? "held" : "failed";
                  }
                  throw new Error(
                    `approval lock reclaim: failed to remove the dead holder's captured lock at ${claimPath}; ${
                      poisoned === "placed"
                        ? `a poison marker now holds ${lockPath} — inspect both by hand and recover with \`fleet unlock\``
                        : poisoned === "held"
                          ? `${lockPath} is HELD (the poison-marker write hit EEXIST) — do NOT run \`fleet unlock\` against a live holder; inspect by hand`
                          : "neither the captured lock nor a poison marker could be resolved — inspect both by hand and recover with `fleet unlock`"
                    }: ${(reclaimErr as Error).message}`,
                  );
                }
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
                } catch (restoreErr) {
                  if ((restoreErr as NodeJS.ErrnoException).code === "EEXIST") {
                    // A new holder re-took the path during the gap. The
                    // captured file is superseded, and discarding it strands
                    // nobody: its owner's fenced release stats the inode now
                    // at `lockPath`, sees it is not its own, and correctly
                    // touches nothing. The unlink happens once, OUTSIDE this
                    // try — see below.
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
                    // write itself fails, the message below names which of the
                    // three states the operator is actually walking into.
                    let poisoned: "placed" | "held" | "failed" = "placed";
                    try {
                      writeFileSync(lockPath, `0:${randomUUID()}`, { flag: "wx", mode: 0o600 });
                    } catch (poisonErr) {
                      // EEXIST is a DIFFERENT fact from an unwritable path: it
                      // means `lockPath` is HELD — by the lock this arm just
                      // restored, or by a successor — which is the safe
                      // outcome, never a vacancy. Reporting it as VACANT (the
                      // old shape) invited precisely the wrong remedy: `fleet
                      // unlock` against a live holder.
                      poisoned = (poisonErr as NodeJS.ErrnoException).code === "EEXIST" ? "held" : "failed";
                    }
                    const disposition =
                      poisoned === "placed"
                        ? `a poison marker now holds ${lockPath} — inspect both by hand and recover with \`fleet unlock\``
                        : poisoned === "held"
                          ? `${lockPath} is HELD by a live holder (the poison-marker write hit EEXIST) — do NOT run \`fleet unlock\` against a live holder; inspect by hand`
                          : `the poison-marker write FAILED too, so ${lockPath} is VACANT — do not rely on it being held; inspect both by hand and recover with \`fleet unlock\``;
                    // The captured file stays preserved at `claimPath` for
                    // operator recovery — never swallow this and retry past a
                    // claimed lock (the `claimed` rethrow below enforces that).
                    throw new Error(
                      `approval lock reclaim: failed to restore replacement lock from ${claimPath} back to ${lockPath}; ${disposition}: ${(restoreErr as Error).message}`,
                    );
                  }
                }
                // OUTSIDE the poison-guarded try, and this placement is the
                // fix: the link has ALREADY succeeded here, so the inode is
                // back at `lockPath` and the replacement's fenced release is
                // safe whatever this unlink does. Sharing the `catch` with the
                // link meant a fault in THIS unlink was reported as a restore
                // fault — whose poison `wx` then hit EEXIST against the HELD
                // path and surfaced a false "lockPath is VACANT" message
                // inviting `fleet unlock` against a live holder. Should this
                // unlink fault, the `claimed` rethrow surfaces it with the path
                // correctly HELD and the claim file preserved: loud, and in the
                // safe direction.
                rmSync(claimPath, { force: true });
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
        // misattributes the fault to lock contention (the "held for over
        // ${LOCK_TIMEOUT_MS}ms" timeout below).
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
      if (Date.now() >= deadline || sleptMs >= LOCK_TIMEOUT_MS) {
        throw new Error(
          `approval lock ${lockPath} held for over ${LOCK_TIMEOUT_MS}ms; if no reverify is running, its holder's pid may have been recycled — run \`fleet unlock ${runId}\` to inspect the holder and reclaim it`,
        );
      }
      await Bun.sleep(LOCK_POLL_MS);
      sleptMs += LOCK_POLL_MS;
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
  try {
    if (statSync(claimPath).ino === st.ino && readFileSync(claimPath, "utf8") === raw) {
      // Genuinely the lock the operator's force decision was about: remove it —
      // BY ITS PRIVATE NAME, so no successor can ever be the file unlinked.
      rmSync(claimPath, { force: true });
      return { outcome: "reclaimed", ...info };
    }
  } catch (verifyErr) {
    // The rename-away has ALREADY vacated `path`, so a fault in this verify
    // window (an EACCES or EIO on the claim read, e.g.) must not surface raw:
    // the verb would die with `path` VACANT and no marker, and the next
    // acquirer's `wx` would succeed straight into the critical section beside
    // the successor this capture displaced. Fail closed the way the acquire
    // loop does — poison the vacant path, then rethrow the ORIGINAL fault so
    // the operator sees the real cause and not a janitorial one.
    try {
      writeFileSync(path, `0:${randomUUID()}`, { flag: "wx", mode: 0o600 });
    } catch (poisonErr) {
      // EEXIST is the SAFE outcome, not a failure: something now holds `path`
      // (a successor re-took it in the gap), which is exactly the state that
      // needs no marker. Anything else leaves the path vacant and unwritable —
      // say so, because the rethrown fault below names neither fact.
      if ((poisonErr as NodeJS.ErrnoException).code !== "EEXIST") {
        noteOnStderr(
          `approval lock reclaim: a verify fault left ${path} VACANT and the poison-marker write failed too (${(poisonErr as Error).message}) — a successor may take it\n`,
        );
      }
    }
    throw verifyErr;
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
  } catch (restoreErr) {
    if ((restoreErr as NodeJS.ErrnoException).code === "EEXIST") {
      // A third waiter re-took `path` during the restore gap; its lock is the
      // live one now and the captured file is superseded. Discarding the
      // capture strands nobody: the successor's own fenced release stats the
      // inode now at `path`, sees a foreign inode, and correctly touches
      // nothing. The unlink happens once, OUTSIDE this try — see below.
    } else {
      // Filesystem fault mid-restore: fail closed — and POISON the vacant
      // `path` before surfacing. The rename-away already vacated it, and
      // rethrowing with the path still empty would let the next acquirer's
      // `wx` succeed and enter the critical section alongside the live
      // successor this capture displaced. A pid-less marker is never
      // auto-reclaimed (`lockHolderPid` → undefined fails the reclaim door),
      // so it holds the path against every later acquirer until the
      // operator's explicit `fleet unlock`. Best-effort: if the marker write
      // itself fails, the message below names which of the three states the
      // operator is actually walking into.
      let poisoned: "placed" | "held" | "failed" = "placed";
      try {
        writeFileSync(path, `0:${randomUUID()}`, { flag: "wx", mode: 0o600 });
      } catch (poisonErr) {
        // EEXIST means `path` is HELD — by the lock just restored or by a
        // successor — the safe outcome, never a vacancy. Reporting it as
        // VACANT (the old shape) invited `fleet unlock` against a live holder.
        poisoned = (poisonErr as NodeJS.ErrnoException).code === "EEXIST" ? "held" : "failed";
      }
      const disposition =
        poisoned === "placed"
          ? `a poison marker now holds ${path} — inspect both by hand and recover with \`fleet unlock\``
          : poisoned === "held"
            ? `${path} is HELD by a live holder (the poison-marker write hit EEXIST) — do NOT run \`fleet unlock\` against a live holder; inspect by hand`
            : `neither the captured lock nor a poison marker could be placed at ${path} — inspect both by hand and recover with \`fleet unlock\``;
      throw new Error(
        `approval lock reclaim: failed to restore captured successor lock from ${claimPath} back to ${path}; ${disposition}: ${(restoreErr as Error).message}`,
      );
    }
  }
  // OUTSIDE the poison-guarded try — same placement as the acquire loop, for
  // the same reason: the link has ALREADY succeeded, so the successor's inode
  // is back at `path` and its fenced release is safe whatever this janitorial
  // unlink does. Left inside the `catch`, a fault here was reported as a
  // restore fault whose poison `wx` hit EEXIST against the HELD path and
  // produced a false VACANT message. Should it fault, the throw surfaces with
  // `path` correctly HELD and the claim file preserved.
  rmSync(claimPath, { force: true });
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

/**
 * The ceiling for `reportId`, matched to run-record.ts's `STRINGS_MAX_ELEMENT_LEN`
 * (not exported). The id is stored verbatim as the approval's `reportId` — a
 * scalar string the store does NOT length-bound — and is appended to
 * `supersededReportIds` on the first rebind away from it, where the per-element
 * 200-char bound DOES throw `schema-rejected` at write time. So an over-bound
 * id does not fail where it arrives: it binds, and then bricks every later
 * rebind of the run until the window expires. Refusing at the door keeps the
 * failure on the call that supplied the value.
 */
export const MAX_REPORT_ID_CHARS = 200;

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
   * not assumed: an open record still naming a `vmName` — or a minted
   * `keyHash` with no box name — refuses to promote
   * without this seam rather than no-op past it (INV-APPROVE-6, see the
   * header).
   *
   * The wired closure must ALREADY hold the run lock for `runId` when it is
   * invoked: DF3.7's production wiring runs inside the chain that acquired it
   * via `acquireRunLock`, and wrapping the seam with `withRunLock` there would
   * throw `RunLockReentrantError` — the run lock is NOT re-entrant. (Test
   * harnesses that hold no lock acquire their own inside the closure.) The
   * gate calls the seam verbatim; the lock it runs under is the caller's.
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
  // INCLUSIVE at the boundary: `now === expiresAt` is past the window, not in
  // it — the usual reading of "expires at", and the fail-safe side for a
  // terminal, irreversible timeout (a decision accepted one tick past the
  // window cannot be taken back; a window closed one tick early can be
  // re-presented). This function is the single expiry oracle for every
  // consumer — rebind, decide, sweep, awaitDecision AND the status display —
  // so the boundary moves for all of them together and display and commit
  // cannot disagree.
  return now.getTime() >= expiresAt ? "timed-out" : state;
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
 * Consecutive CORRUPT reads tolerated before a poller gives up on a record.
 *
 * The store's INV-4 throw (`malformed run record …` — truncated JSON, an unknown
 * key, a schema-invalid body) is not absence and not a decision: a body that
 * will not parse is a record damaged on disk (a truncated write, a hand-edit, a
 * schema the store refuses), and this module cannot tell from one read whether
 * the damage is still landing or is final. Treating it as a DECISION is
 * impossible here (nothing is returned), so the only two choices are "keep
 * polling" and "throw". Ten consecutive failures at `awaitDecision`'s default
 * 1 s poll is ten seconds of unbroken corruption — far past any transient —
 * and short enough that a truly broken record surfaces inside a human-sized
 * wait rather than after it.
 */
const MAX_CORRUPT_POLLS = 10;

/**
 * Consecutive corrupt reads per run id. Module-level because the two pollers
 * (`awaitDecision`'s loop, the sweeper that calls `sweepExpired` repeatedly)
 * share the record on disk and therefore share one corruption; an entry exists
 * only while a record is actually failing to parse, and is dropped on the first
 * successful read, on ENOENT, and on the throw.
 */
const corruptReads = new Map<string, number>();

/**
 * Is this the store's CORRUPT-BODY throw rather than a filesystem fault?
 *
 * `readRecord` throws `malformed run record <id>.json: …` with NO `code` on the
 * JSON.parse and `assertWellFormed` paths, and re-throws real I/O errors with
 * their errno preserved — the same classification `status.ts`'s handler makes.
 * Keying on "no code AND the store's own prefix" therefore cannot mistake an
 * EACCES/EIO/EMFILE fault for a corrupt body or vice versa, and it survives a
 * caller-controlled id inside the message (the prefix is store-authored, the
 * id is not what is matched on).
 */
function isCorruptRecordError(e: unknown): boolean {
  if ((e as NodeJS.ErrnoException | null)?.code !== undefined) return false;
  return String((e as Error | null)?.message ?? "").startsWith("malformed run record ");
}

/**
 * The record's body is durably unparseable and the poller has run out of
 * patience. A dedicated subclass, not a message prefix, for the same reason
 * `InvalidRunIdError` is (run-record.ts): a consumer must be able to tell
 * "this record is broken" from any other failure without matching prose.
 */
export class CorruptApprovalRecordError extends Error {
  readonly runId: string;
  readonly code = "approval-record-corrupt";
  constructor(runId: string, cause: unknown) {
    super(
      `approval record for ${runId} is unreadable (malformed run record body) after ${MAX_CORRUPT_POLLS} consecutive reads — the record is durably broken, not merely missing; inspect it by hand before trusting any verdict for this run`,
    );
    this.name = "CorruptApprovalRecordError";
    this.runId = runId;
    this.cause = cause;
  }
}

/**
 * The TOLERANT reader, for callers that POLL. ENOENT ⇒ no such run, the
 * `stampFanoutExtension` idiom. Everything else throws — EXCEPT a corrupt
 * body, which is an OBSERVATION and never a decision: it is reported as "no
 * approval extension to read" for up to `MAX_CORRUPT_POLLS` consecutive reads
 * and then re-raised as `CorruptApprovalRecordError`. See `readApproval` above
 * for why the ENOENT posture differs from the strict reader on purpose.
 *
 * The bound is what keeps this from failing OPEN. Without it, a record
 * truncated by a full disk made `awaitDecision` throw on its FIRST poll —
 * collapsing a 24 h human-decision wait and reporting it as a gate crash — and
 * made a sweep abort on a run it could not read. With it, transient corruption
 * rides out and durable corruption still gets loud.
 */
function readApprovalIfPresent(store: RunRecordStore, runId: string): ExtensionEntry | undefined | null {
  try {
    const ext = readApproval(store, runId);
    corruptReads.delete(runId);
    return ext;
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") {
      corruptReads.delete(runId);
      return null;
    }
    if (isCorruptRecordError(e)) {
      const seen = (corruptReads.get(runId) ?? 0) + 1;
      if (seen > MAX_CORRUPT_POLLS) {
        corruptReads.delete(runId);
        throw new CorruptApprovalRecordError(runId, e);
      }
      corruptReads.set(runId, seen);
      // "No decision yet": the same answer an absent extension gets, so every
      // poller above keeps waiting or skips this pass without a special case.
      return undefined;
    }
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
  // TRIMMED: every element here is a reportId, and this array feeds the
  // stale-report refusal and the dedupe — a whitespace-polluted entry (a
  // hand-edit) must compare equal to the clean id it names, not become a
  // second, phantom report in the trail.
  return Array.isArray(raw)
    ? raw.filter((id): id is string => typeof id === "string").map((id) => id.trim())
    : [];
}

/**
 * A report naming a run whose harvested bundle is gone — or present but EMPTY —
 * is bound to nothing.
 *
 * Checked on BOTH write paths, not just the rebind. The first request is the
 * one that binds an approval to a run in the first place, so a missing bundle
 * there is strictly worse: an approver is asked to authorize a PR from a bundle
 * that no longer exists, and nothing later re-checks. The terminal and
 * `pause-in-progress` branches deliberately do NOT reach here — a decided
 * record still reports its decision whatever became of the bundle. That
 * routing is why the empty case needs no extra guard: every call site is
 * reached only from a non-terminal state (resume: `pausing`; rebind:
 * `awaiting-approval`; pause: no extension; decide: after the terminal arms
 * have already returned), so a decided record is never refused over its
 * bundle, empty or otherwise.
 */
function assertBundlePresent(deps: GateDeps, runId: string, verb: string): void {
  if (deps.bundleDir === undefined) return;
  const bundlePath = join(deps.bundleDir, `${runId}.bundle`);
  if (!existsSync(bundlePath)) {
    throw new Error(
      `cannot ${verb} ${runId}: its harvested bundle is gone from ${deps.bundleDir} — a report naming a run with no bundle is bound to nothing`,
    );
  }
  // Existence alone is not presence: a bundle truncated or zeroed AFTER harvest
  // (a full disk, a killed writer) still answers `existsSync`, and without this
  // stat an approver would be asked to authorize a PR from evidence that is not
  // there. A separate refusal, not folded into the gone-case message, so an
  // operator can tell "deleted" from "damaged".
  // The stat is TOCTOU-guarded: the bundle can be deleted between the
  // `existsSync` above and this stat, and a raw `ENOENT: no such file …` out of
  // `statSync` would replace the authored refusal with an anonymous filesystem
  // fault on exactly the race window this check exists to police. Same
  // refusal, second look.
  let size: number;
  try {
    size = statSync(bundlePath).size;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        `cannot ${verb} ${runId}: its harvested bundle is gone from ${deps.bundleDir} — a report naming a run with no bundle is bound to nothing`,
      );
    }
    throw e;
  }
  if (size > 0) return;
  throw new Error(
    `cannot ${verb} ${runId}: its harvested bundle at ${bundlePath} is empty (0 bytes) — truncated after harvest, so a report naming it is bound to nothing`,
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
  /** "unknown" until a record has been read — never a guessed state. Back-filled from a tolerant record read on the error path only (see `requestApproval`'s `finally`). */
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
    // CLAMPED at zero: a backward clock step (NTP correction, a resumed laptop)
    // after `ctx.startedAt` would land a negative duration on the event line —
    // the same observed-on-macOS shape `reclaimApprovalLock` clamps its
    // `ageMs` for, in a field whose whole job is to be a sane duration.
    const durationMs = Math.max(0, Date.now() - ctx.startedAt);
    // Falsy, not just `undefined`: an EMPTY-string dispatch id (a hand-edited
    // record) would ride past an `undefined` check and be reported as a real
    // join key `""` — one that joins to nothing but is indistinguishable in
    // the stream from an id that does. `""` IS "no id was read".
    const dispatch = ctx.dispatchRequestId ? boundedEcho(ctx.dispatchRequestId) : undefined;
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
    // On the ERROR path the state the record actually holds is usually
    // observable and worth reporting — a throw between the register and the
    // promote leaves `pausing` on disk by design, and "unknown" on the event
    // line hides exactly the fact an operator is debugging. Tolerant read,
    // best-effort only: this is a `finally`, so anything it raises would
    // REPLACE the real failure, and a record that cannot be read right now
    // keeps the honest "unknown". Only the error path takes this branch —
    // every non-error exit already set `state` itself, including the promote
    // race, whose "unknown" means genuinely unobservable.
    if (ctx.outcome === "error" && ctx.state === "unknown") {
      try {
        const ext = readApprovalIfPresent(deps.store, runId);
        if (ext !== null && ext !== undefined) {
          const recorded = String(ext.state ?? "");
          if (recorded !== "") ctx.state = recorded;
        }
      } catch {
        // The original error is the one that must reach the caller.
      }
    }
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
  // Capped at the door, not at the write: the store length-bounds the elements
  // of `supersededReportIds` but not the scalar `reportId` field, so an
  // over-bound id binds fine and then throws `schema-rejected` on the FIRST
  // rebind away from it — bricking every later rebind of the run. See
  // `MAX_REPORT_ID_CHARS`.
  if (reportId.length > MAX_REPORT_ID_CHARS) {
    throw new Error(
      `approval requires a reportId of at most ${MAX_REPORT_ID_CHARS} chars, got one of ${reportId.length} starting ${JSON.stringify(reportId.slice(0, 64))} — a longer id would bind but brick the first rebind that has to record it as superseded`,
    );
  }
  // Through `String()`: the request type is compile-time only, so `headSha` may
  // be absent at runtime, and a bare `.slice` on it would replace this
  // diagnostic with a `TypeError` naming nothing. LOWER-CASED before the
  // regex: git emits hex lower-case, but a caller that round-tripped the sha
  // through something that upper-cased it (`git log --pretty=... | tr`, a JSON
  // tool's default) is naming the same commit, and HEAD_SHA_RE's own test pins
  // that a legit 40-hex sha binds. The STORED form is that lower-cased value —
  // every comparison against it (`submitDecision`'s reportId CAS, the resume
  // arm's headSha match, DF5.2's push-side recheck) is against the record's own
  // field, never re-derived here, so normalizing at the door is the one place
  // it can be done without splitting the case across two stores of truth.
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
      // TRIMMED on the stored side too: the incoming id is trimmed at the door,
      // and a stored id carrying stray whitespace (a hand-edit) must still
      // match its own report or the run wedges as `pause-in-progress` forever.
      const pausedReportId = String(existing?.reportId ?? "").trim();
      // A `pausing` record naming NO report cannot be resumed by ANY
      // re-presentation: the compare below can only ever answer
      // `pause-in-progress`, `pausing` never expires, and this arm is the only
      // promoter — so the record would wedge silently forever while every
      // reverify retry returns a bland non-answer. Name the damage instead.
      if (pausedReportId === "") {
        throw new Error(
          `refusing to resume ${runId}: its pausing approval extension names no reportId, so no re-presented report can ever match it and the record can never be promoted — the run is wedged by a damaged record, not by a competing pause; inspect it with \`fleet status ${runId}\` and correct or clear the extension deliberately`,
        );
      }
      if (pausedReportId !== reportId) return { outcome: "pause-in-progress" };
      // BYTE-IDENTICAL ON BOTH FIELDS, not the reportId alone. A resume is the
      // arm that promotes whatever this record was paused against, so a
      // re-present that pairs the STRANDED reportId with a different — a
      // FRESH commit's — headSha would promote an approval bound to report A
      // onto code from commit B, with no rebind in between to record the
      // change. Same rule as the reportId above: the stored sha is lower-cased
      // as written (see the door), and any disagreement refuses.
      const pausedHeadSha = String(existing?.headSha ?? "").toLowerCase();
      if (pausedHeadSha !== headSha) {
        throw new Error(
          `refusing to resume ${runId}: it is paused against report ${reportId} at headSha ${JSON.stringify(
            pausedHeadSha.slice(0, 64),
          )}, but the re-presented report carries headSha ${JSON.stringify(
            headSha.slice(0, 64),
          )} (approval-report-mismatch) — a resume may not move a paused approval onto different code; re-run the verify for the original commit, or let the window expire`,
        );
      }
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
      // SAME RULE AS THE RESUME ARM, for the identical rebind: re-presenting
      // the CURRENTLY BOUND reportId against a different headSha would move the
      // live approval onto different code with NO supersession recorded (the
      // identical-rebind skip below appends nothing to the history), leaving a
      // record that authorizes a decision over commit B while its bound report
      // describes commit A. A rebind to a DIFFERENT reportId may of course
      // carry a new headSha — that is the designed supersession flow. The
      // pairing the resume arm refuses (stranded report + fresh commit) is the
      // pairing refused here.
      const boundReportId = String(existing?.reportId ?? "").trim();
      const boundHeadSha = String(existing?.headSha ?? "").toLowerCase();
      if (boundReportId === reportId && boundHeadSha !== headSha) {
        throw new Error(
          `refusing to rebind ${runId}: report ${reportId} is bound at headSha ${JSON.stringify(
            boundHeadSha.slice(0, 64),
          )}, but the re-presented report carries headSha ${JSON.stringify(
            headSha.slice(0, 64),
          )} (approval-report-mismatch) — a rebind may not move an unchanged report onto different code; re-run the verify for the original commit, or rebind to a new report`,
        );
      }
      const history = historyOf(existing);
      // A reportId already recorded as SUPERSEDED is dead: it was displaced by
      // the rebind that appended it, and nothing un-displaces one. Accepting it
      // again would re-bind the live approval to a report the record itself
      // says is stale — which is exactly what a reverify worker that pre-read
      // the record outside this lock and lost the race presents on retry. The
      // history is append-only and this refusal is the only thing standing
      // between a stale re-present and a decision taken over a displaced
      // report.
      if (history.includes(reportId)) {
        throw new Error(
          // Echoes bounded: `reportId` is door-capped, but the STORED binding
          // is whatever the record holds — a hand-edited megabyte id must not
          // flood the refusal text.
          `refusing to rebind ${runId} to ${reportId}: that report is already recorded as superseded (approval-report-stale) — the live binding is ${boundedEcho(
            boundReportId,
          )}; re-verify the currently bound report instead`,
        );
      }
      // APPEND, oldest-first. `validateExtensions` REPLACES a field's value and
      // has no append semantics, so this is a read-modify-write — which is why
      // the lock is load-bearing here and not merely tidy: two concurrent
      // rebinds would each read [a] and write [a,b] / [a,c], losing one
      // displaced id and breaking the DoD that no decision may name a reportId
      // absent from both `reportId` and `supersededReportIds`.
      const supersededReportId = boundReportId;
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

    // FAIL CLOSED on an unrecognized state rather than re-registering over it.
    // Everything this module writes, and everything it reasons about, is one of
    // `pausing`, `awaiting-approval` or a terminal value — an open record whose
    // `state` is none of those (a hand-edit, a truncated write, schema drift)
    // reached here only by falling off the end of the arms above, and the old
    // fall-through treated that as "no approval yet": it minted a fresh window
    // and reset `supersededReportIds` to [], silently destroying the audit
    // trail the record was keeping. Whatever that state was protecting, this
    // call is not the one qualified to overwrite it.
    // The extension being PRESENT is the trigger, including `state` missing or
    // `""`: `String(existing.state ?? "")` normalizes both to "", which the old
    // `state !== ""` guard exempted — and the fresh register below resets
    // `supersededReportIds` to [], so the exact destruction this guard exists
    // to prevent went through the exemption. An extension with no state is as
    // unrecognizable as one with a foreign state, and gets the same refusal.
    if (state !== undefined) {
      throw new Error(
        `refusing to pause ${runId}: its approval extension is in state ${JSON.stringify(
          state,
        )}, which is none of pausing, awaiting-approval or a terminal state (approval-state-unrecognized) — re-registering over it would reset its supersededReportIds history and mint a fresh window, so nothing was written; inspect the record with \`fleet status ${runId}\` and correct or clear the state deliberately`,
      );
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
  // naming a `vmName` — or a `keyHash` with no box name, which is a minted key
  // nothing here can revoke — contradicts it. Promoting there would hand an
  // approver a decidable run sitting over live, billing infrastructure, which
  // is exactly the coexistence INV-APPROVE-6 forbids; `await
  // deps.teardown?.(...)` on an absent seam is a no-op that looks in every log
  // like a teardown that ran. Same posture as R5-C above: refuse BEFORE the
  // irreversible step, leave the `pausing` extension standing so the run is
  // recoverable, and make the refusal auditable rather than silent. The same
  // classification `refuseLiveInfraOnDecidable` uses names what is actually
  // standing, so a key-only record is refused for the key and not described as
  // a box.
  if ((rec.vmName !== undefined || rec.keyHash !== undefined) && rec.closedAt === undefined && deps.teardown === undefined) {
    const what =
      rec.vmName === undefined
        ? "a minted key"
        : `box ${rec.vmName}${rec.keyHash === undefined ? "" : " and its minted key"}`;
    // A named box keeps the original refusal text verbatim; a key-only record
    // gets the key-shaped variant. Same shape, different noun — describing a
    // key as a box would send the operator looking for a VM that does not
    // exist.
    const blocker = rec.vmName === undefined ? "The live infrastructure is the blocker" : "The live box is the blocker";
    throw new Error(
      `refusing to pause ${runId}: its record is open and still owns ${what}, but no teardown seam was provided, so this pause cannot destroy or revoke it and would promote a decidable run over live infrastructure — call the gate from a caller that passes GateDeps.teardown, or run \`fleet teardown ${runId}\` first. ${blocker}, not a crashed pause: the record stays \`pausing\` and re-running reverify re-refuses here until it is destroyed`,
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
    // Restamp the window AT PROMOTION, both fields — the same treatment the
    // resume arm gives its restamp. The stamps were taken at registration,
    // BEFORE the teardown between the two writes, and teardown runs "seconds
    // to minutes": with `timeoutMs` near the 60 s floor a box teardown alone
    // could consume the whole window, promoting a record that is already past
    // `expiresAt` — `awaitDecision`'s first poll then answers a timeout no
    // human ever declined. Promotion is the instant the run actually becomes
    // decidable, so it is the instant the window starts.
    const promotedAt = nowOf(deps);
    store.set(runId, {
      extensions: {
        approval: {
          state: "awaiting-approval",
          requestedAt: promotedAt.toISOString(),
          expiresAt: new Date(promotedAt.getTime() + resolveTimeoutMs(deps)).toISOString(),
        },
      },
    });
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
 * minutes against a LOCK_TIMEOUT_MS wait ceiling), so two same-reportId resumes of one
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
 * concurrent teardown — the pre-claim status quo, never worse. So, once a
 * claim has aged past LOCK_STALE_MS, an EMPTY pid-less claim OR a claim with a
 * provably DEAD parsed pid is reclaimable. The empty case matters because a
 * claim with no pid yet is one this loop is mid-write on: the `wx` opens the
 * file BEFORE `writeFileSync` lands the content, so another waiter can observe
 * EEXIST against an empty file whose holder pid it can never read. Reclaiming
 * that instantly destroys a lock the moment it was taken. A NON-empty
 * pid-less claim is NOT reclaimable: the restore-fault arm below leaves a
 * `0:<uuid>` poison marker whose whole job is to hold the path against every
 * later resume, and treating unparseable-but-non-empty content as "no holder"
 * would sweep that marker stale and reopen the concurrent-teardown race it
 * exists to end. Age past LOCK_STALE_MS is the same door the approval lock
 * uses, and at that age the writer is provably gone (the guarded body outlives
 * the timeout by construction — see LOCK_STALE_MS).
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
  // This acquisition's identity, for the same reason `withApprovalLock` keeps
  // one: the take below re-verifies through the PATH before believing it won.
  let ownIno = -1;
  // Actual time spent asleep — the belt behind the wall-clock `deadline` (a
  // backward clock step would otherwise keep a wall-only gate from ever
  // firing). Sleep is all this loop waits on, so the accumulator is a lower
  // bound on real elapsed time: it can fire late, never early.
  let sleptMs = 0;
  for (;;) {
    try {
      // Open, write, and MEASURE OUR OWN INODE — the same three steps the
      // approval lock takes. `writeFileSync(claimPath, own, { flag: "wx" })`
      // would do the first two in one call, but a process suspended between
      // its open and its write leaves an EMPTY claim on the path, which a
      // waiter past LOCK_STALE_MS reclaims by right (a claim naming no holder
      // can never name a live one); this process would then resume, write to
      // the unlinked inode, and run teardown CONCURRENTLY with the waiter's —
      // the exact `pullArtifacts` interleave this claim exists to prevent.
      const fd = openSync(claimPath, "wx", 0o600);
      try {
        writeFileSync(fd, own);
        ownIno = fstatSync(fd).ino;
      } catch (writeErr) {
        // Same cleanup as the approval lock, with the same fence the approval
        // lock now carries: `ownIno` is still -1 here by construction, so the
        // old `ownIno === -1 ||` guard was a constant TRUE — and this process
        // can be suspended between the `wx` open and this write past
        // LOCK_STALE_MS, long enough for a waiter to reclaim the empty claim
        // and a successor to re-take the path. Removing by path would then
        // unlink the SUCCESSOR's claim and let two teardowns run concurrently.
        // Only remove while the path still resolves to the file THIS fd
        // created.
        try {
          if (statSync(claimPath).ino === fstatSync(fd).ino) rmSync(claimPath, { force: true });
        } catch {
          // Left behind on purpose: the stale door below recovers an empty
          // claim past LOCK_STALE_MS, which beats proceeding without a claim.
        }
        throw writeErr;
      } finally {
        closeSync(fd);
      }
      // RE-VERIFY through the path: does it still resolve to the file THIS
      // call created? A mismatch — or a throw, the same fact through a
      // vanished path — means a reclaimer won and owns the claim now; treat it
      // as the EEXIST the catch below understands, so the loss waits out the
      // live holder instead of skipping the deadline check.
      let stillOurs = false;
      try {
        stillOurs = statSync(claimPath).ino === ownIno;
      } catch {
        stillOurs = false;
      }
      if (!stillOurs) {
        ownIno = -1;
        throw Object.assign(
          new Error(`teardown claim ${claimPath}: the empty claim this call created was reclaimed before its content landed`),
          { code: "EEXIST" },
        );
      }
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      // ONE door: proof of death, with age as a PRECONDITION for looking — the
      // approval lock's rule, cheapened only in the failure direction. Age
      // first means a fresh claim is never even inspected, so the no-content
      // window between `wx` and the content write is never mistaken for a dead
      // holder. Past LOCK_STALE_MS, an EMPTY pid-less claim OR a dead parsed
      // pid reclaims: this fence's failure direction makes that safe (see the
      // header).
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
      let holderPid: number | undefined;
      try {
        const age = Date.now() - statSync(claimPath).mtimeMs;
        if (age > LOCK_STALE_MS) {
          const raw = readFileSync(claimPath, "utf8");
          holderPid = lockHolderPid(raw);
          // THE SAME CONJUNCTION AS THE APPROVAL LOCK'S DOOR: a claim naming NO
          // pid is reclaimable only when its content is EMPTY — the zero-byte
          // file a crash between the `wx` and the content write strands. Any
          // NON-empty content with no parseable pid is unproven, and unproven
          // death is never reclaimed implicitly. This is not style: the
          // restore-fault arm below leaves a `0:<uuid>` poison marker whose
          // whole job is to hold the path against every later resume, and a
          // door that read `undefined` as "no holder" would sweep that marker
          // stale and reopen the concurrent-teardown race it exists to end.
          if (holderPid === undefined ? raw.trim() === "" : isLockHolderDead(holderPid)) {
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
              // Another racer stole it first. Forget the pid read above: it
              // described a claim that is already gone, and a timeout thrown
              // from this iteration must not send the operator to a process
              // that holds nothing.
              holderPid = undefined;
            }
            if (stolen) {
              // Any FAULT below — the read-back or the removal — leaves
              // `claimPath` VACANT (the steal-rename above) with the captured
              // claim stranded at its private path. Rethrowing raw would let
              // the next resume's `wx` succeed and run teardown concurrently
              // with whatever live holder this capture displaced — the exact
              // interleave this fence exists to prevent. Poison the vacancy
              // before surfacing, exactly like the restore-fault arm below.
              const failVacant = (cause: unknown): never => {
                let poisoned = true;
                try {
                  writeFileSync(claimPath, `0:${randomUUID()}`, { flag: "wx", mode: 0o600 });
                } catch {
                  // vacant-and-unwritable joins stranded-at-stealPath as an
                  // operator-recovery state; the message below names both.
                  poisoned = false;
                }
                throw new Error(
                  `teardown claim: failed while reclaiming the captured claim at ${stealPath}; ${
                    poisoned
                      ? `a poison marker now holds ${claimPath} — inspect both by hand and remove the marker only once no teardown is running`
                      : `neither the captured claim nor a poison marker could be placed at ${claimPath} — inspect both by hand before running another resume`
                  }: ${(cause as Error).message}`,
                );
              };
              let captured: string | undefined;
              try {
                captured = readFileSync(stealPath, "utf8");
              } catch (stealErr) {
                if ((stealErr as NodeJS.ErrnoException).code === "ENOENT") {
                  // The capture vanished off its private path — nothing holds
                  // it and `claimPath` is vacant the ordinary way; retry the
                  // `wx` like any other vanish (bounded by the deadline below).
                } else {
                  failVacant(stealErr);
                }
              }
              if (captured !== undefined && captured === raw) {
                // Genuinely the dead holder's claim: remove it and re-take.
                try {
                  rmSync(stealPath, { force: true });
                } catch (rmErr) {
                  failVacant(rmErr);
                }
              } else if (captured !== undefined) {
                // A live replacement re-took the path between the read and
                // the rename. Restore the VERY FILE — same inode, no vacancy
                // created — so its owner's content-fenced release still
                // recognises it, then wait like any other live holder.
                try {
                  linkSync(stealPath, claimPath);
                } catch (linkErr) {
                  if ((linkErr as NodeJS.ErrnoException).code !== "EEXIST") {
                    // Anything else is a filesystem fault: fail closed — and
                    // POISON the vacant `claimPath` before surfacing. The
                    // steal-rename already vacated it, and rethrowing with the
                    // path still empty would let the next resume's `wx` open
                    // succeed and run teardown concurrently with the live
                    // holder this capture displaced — the exact serialization
                    // this claim exists to enforce. A pid-less marker is never
                    // auto-reclaimed: the reclaim door takes a claim with no
                    // parseable pid only when its content is EMPTY, and this
                    // marker is non-empty by construction, so it holds the
                    // path against every later resume until the operator
                    // removes it by hand.
                    // Best-effort: if the marker write itself fails, the path
                    // stays VACANT — and the message below names which of the
                    // two states the operator is actually walking into. The
                    // captured file stays preserved at `stealPath` (its owner
                    // can be identified from it) either way.
                    let poisoned = true;
                    try {
                      writeFileSync(claimPath, `0:${randomUUID()}`, { flag: "wx", mode: 0o600 });
                    } catch {
                      // vacant-and-unwritable joins stranded-at-stealPath as an
                      // operator-recovery state; the message below names both.
                      poisoned = false;
                    }
                    throw new Error(
                      `teardown claim: failed to restore the captured claim from ${stealPath} back to ${claimPath}; ${
                        poisoned
                          ? `a poison marker now holds ${claimPath} — inspect both by hand and remove the marker only once no teardown is running`
                          : `neither the captured claim nor a poison marker could be placed at ${claimPath} — inspect both by hand before running another resume`
                      }: ${(linkErr as Error).message}`,
                    );
                  }
                  // EEXIST: a new holder re-took the path during the gap; its
                  // claim is the live one now and the captured file is
                  // superseded. Discarding the capture strands nobody: the new
                  // holder's claim is the one later waiters see, and the
                  // restore itself added no second vacancy.
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
      }
      // UNCONDITIONAL deadline and sleep — NOT gated on whether the holder
      // looked live. The vanish/reclaim paths used to skip
      // BOTH, so a claim path churning under concurrent reclaimers (or a vanish
      // between the EEXIST and the stat) re-iterated with no sleep and no
      // deadline check, `sleptMs` never advanced, and the loop burned CPU at
      // full tilt well past CLAIM_TIMEOUT_MS — exactly the busy-spin the
      // `withApprovalLock` loop prevents by running these two after every
      // failed iteration, its own comment calling the gate out by name. A
      // reclaim retry now pays one LOCK_POLL_MS of sleep, nothing against a
      // teardown.
      if (Date.now() >= deadline || sleptMs >= CLAIM_TIMEOUT_MS) {
        throw new Error(
          `approval teardown claim ${claimPath} not acquirable after ${CLAIM_TIMEOUT_MS}ms${
            holderPid === undefined ? "" : ` (last inspected holder pid ${holderPid})`
          }; a live teardown does not run this long — check for a sandbox-teardown process, remove ${claimPath} only if none is running, then re-run the resume. A non-empty claim naming no pid is a poison marker a failed restore left behind; the restore-fault error names its recovery`,
        );
      }
      await Bun.sleep(LOCK_POLL_MS);
      sleptMs += LOCK_POLL_MS;
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
    // Echo bounded: the value is runtime-unchecked, so its raw form could be
    // operator- or caller-chosen text of any length.
    throw new Error(
      `a decision must be "approved" or "rejected", got ${JSON.stringify(String(req.decision).slice(0, 64))}`,
    );
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
  // REFUSED over the bound, not truncated: this field lands in a TERMINAL
  // record ("terminal here means immutable"), so a capText-mangled value would
  // be uncorrectable — DF5.2's approver allowlist can never match it and a
  // legitimately authorized approval would die at push with no diagnostic that
  // reshaping happened. Refusal also keeps the reserved check above honest:
  // the value checked IS the value stored, where validate-then-truncate let a
  // capped value embed TIMEOUT_APPROVER_ID as a prefix the equality check
  // never saw.
  if (approverId.length > MAX_APPROVER_ID_CHARS) {
    throw new Error(
      `approverId exceeds ${MAX_APPROVER_ID_CHARS} chars — it is written once into a terminal, immutable record, so an over-bound value is refused rather than silently truncated`,
    );
  }
  const cappedApproverId = approverId;

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

    // Trimmed on BOTH sides of the compare-and-set, matching what
    // `requestApproval` bound — otherwise a `$(...)`-captured id with a
    // trailing newline is answered `report-changed` against the id it IS, and
    // a stored id carrying stray whitespace (a hand-edit) wedges every later
    // decision the same way.
    const bound = String(existing.reportId ?? "").trim();
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
 *
 * A CORRUPT record is skipped, never timed out: `readApprovalIfPresent` answers
 * "no approval extension" while the corruption is within `MAX_CORRUPT_POLLS`
 * consecutive reads, and both reads here then return `false` without a write —
 * a body nobody could parse carries no `expiresAt` to honour, so writing
 * `timed-out` over it would be inventing a decision. One unreadable run cannot
 * abort a sweep of others: this call is per-run and the corrupt case returns
 * `false` like any other "nothing to write", only surfacing
 * `CorruptApprovalRecordError` once the corruption outlasts the bound.
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
 * A CORRUPT record body is an observation, not a decision: it polls on as "no
 * answer yet" for up to `MAX_CORRUPT_POLLS` consecutive reads and then throws
 * `CorruptApprovalRecordError` rather than answering `null` — `null` is a
 * reported non-answer a caller waits out, and a durably broken record is
 * neither a non-answer nor something a 24 h wait can repair.
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
  // A window of zero or less still answers an ALREADY-RECORDED decision
  // immediately — the record is checked before the deadline is — and returns
  // `null` only when nothing is there yet, which is the honest reading of
  // "wait zero": reported, not silent.
  const requestedWait = opts.waitMs ?? DEFAULT_TIMEOUT_MS;
  const waitMs = Number.isFinite(requestedWait) ? Math.max(requestedWait, 0) : DEFAULT_TIMEOUT_MS;
  const deadline = Date.now() + waitMs;
  // Actual time spent asleep, the belt behind the wall clock: a backward clock
  // step makes `Date.now() >= deadline` false forever, and this loop would
  // poll past its own window indefinitely. Sleep is all it waits on, so the
  // accumulator is a lower bound on real elapsed time — it can fire a little
  // late, never early.
  let sleptMs = 0;
  for (;;) {
    const ext = readApprovalIfPresent(deps.store, runId);
    if (ext !== null && ext !== undefined) {
      // A PERSISTED decision is reported verbatim; a derived expiry is
      // reconstructed, because no writer has been past it yet.
      if (TERMINAL.has(String(ext.state ?? ""))) return decisionOf(ext);
      if (expiredState(ext, nowOf(deps)) === "timed-out") return derivedTimeout(ext);
    }
    if (Date.now() >= deadline || sleptMs >= waitMs) return null;
    // Each sleep is clamped to the REMAINING window, so a caller-supplied
    // pollMs longer than what is left cannot carry this loop past the window
    // it was asked to observe (a 24 h poll against a 60 s wait would
    // otherwise answer `null` a day late).
    const nap = Math.min(pollMs, deadline - Date.now());
    await Bun.sleep(nap);
    sleptMs += nap;
  }
}
