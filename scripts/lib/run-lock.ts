/**
 * The per-run invocation lock (DF2.5) — shared by every CLI that can harvest
 * or tear a run down (`scripts/sandbox-teardown.ts`, `scripts/fleet.ts`).
 *
 * One invocation per run at a time: `<runsDir>/<runId>.lock` serializes
 * concurrent CLI calls; a stale lock is reported (never stolen) with the
 * holder's pid, whether that pid is still alive, and the exact `rm` that
 * clears it. This is a concurrency guard for destructive verbs, so the two
 * entry points share ONE implementation — acquire AND release both live here
 * so the semantics cannot drift per CLI.
 *
 * Lock body: `<pid> <host> <createdAt-ISO> <nonce>`. The host field is what
 * makes the pid meaningful: `kill(pid, 0)` answers about THIS host's process
 * table (and about this PID NAMESPACE's — see `lockHost`), and a shared runs
 * directory (an NFS mount, a bind-mounted volume, a CI runner and a laptop)
 * makes that answer about a stranger. Bodies written before the field existed
 * are `<pid> <ISO> <nonce>` and still parse — the field that looks like an ISO
 * timestamp tells the two layouts apart — but they parse to an UNKNOWN host,
 * which is treated as foreign: their pid is never probed and they are never
 * marked stale. Back-compat that opted old bodies out of the guard would
 * re-open the very bug the guard was added for.
 */

import { randomBytes } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  linkSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";

import { assertValidRunId } from "../../src/providers/run-record.ts";

/**
 * `<runId>.lock` is already held by another invocation. Carries the
 * code/remediation shape the CLIs' catch blocks map onto their error output —
 * thrown between the record read and any mutation, so a refused invocation
 * touches nothing.
 *
 * `holder` names the entry point in the operator's own vocabulary
 * ("sandbox-teardown", "fleet invocation"); the message is the one an operator
 * greps for, so each CLI keeps the wording it has always printed.
 */
export class RunLockedError extends Error {
  readonly code = "run-locked";
  readonly remediation: string;
  /**
   * The machine-readable claim "no live process holds this lock", surfaced so
   * observers of a refusal (`withRunLock`'s acquire log, a caller classifying
   * outcomes) can tell the proven-dead flavor from a mere contention refusal
   * without parsing the remediation prose. `refuse` is the only writer, and it
   * sets it exactly where it already drives the `rm`-then-re-run advice.
   */
  readonly stale: boolean;
  constructor(lockPath: string, who: string, holder = "invocation", stale = false, note = "") {
    super(`another ${holder} holds ${lockPath} (${who})`);
    this.stale = stale;
    this.remediation =
      (stale
        ? `no live process holds it (${who}) — rm ${lockPath} to clear the stale lock, then re-run`
        : `wait for that invocation to finish — or, only if ${who} is gone: rm ${lockPath}`) + note;
  }
}

/**
 * The run lock is NOT re-entrant, and the refusal for a second acquire in the
 * SAME process used to read "another invocation holds … (pid <self>)" — telling
 * the operator to wait for themselves. Its own code so a caller can tell a
 * programming error apart from a genuine contention refusal.
 */
export class RunLockReentrantError extends Error {
  readonly code = "run-lock-reentrant";
  readonly remediation = "release the lock before acquiring it again — the run lock is not re-entrant";
  constructor(lockPath: string) {
    super(`this process already holds ${lockPath}`);
  }
}

/**
 * Module state — `held`, `destructive`, and the two unwind latches — parked on
 * `globalThis` under a registered symbol instead of in module scope.
 *
 * CJS+ESM DUAL-LOAD. One process can load this file twice (an ESM caller and a
 * CJS dependency of the same embedder resolve it as two instances), and every
 * piece of state above USED to be per-instance — so the safety proofs that
 * read `held` were proofs about HALF the process's locks:
 *
 *  - the `held.has(lock)` reentrancy guard missed a claim the twin instance
 *    holds;
 *  - worse, `refuse`'s own-pid branch asks "is this REALLY one of mine?" by
 *    scanning `held` — the twin's LIVE lock answered "proven unheld" and was
 *    marked `stale=true`, printing `rm <lock>` advice for a lock this very
 *    process actively holds. The uniqueness argument ("this pid is ours, so
 *    no live invocation can hold it") is simply false across instances.
 *
 * Sharing one registry through `Symbol.for` — which both module systems land
 * on in the same process — makes both proofs whole again with no API change.
 * `worker_threads`/`Bun.Worker` deliberately get their own copy: threads are
 * separate holders by construction everywhere else in this module (record
 * store locks reason about sibling threads the same way).
 */
interface RunLockModuleState {
  held: Map<string, string>;
  destructive: Set<string>;
  signalsInstalled: boolean;
  unwinding: boolean;
}

/* eslint-disable @typescript-eslint/no-unnecessary-condition */
function moduleState(): RunLockModuleState {
  const key = Symbol.for("qds.run-lock.state");
  let state = (globalThis as Record<symbol, unknown>)[key] as RunLockModuleState | undefined;
  if (state === undefined || state.held === undefined || state.destructive === undefined) {
    state = { held: new Map(), destructive: new Set(), signalsInstalled: false, unwinding: false };
    (globalThis as Record<symbol, unknown>)[key] = state;
  }
  return state;
}
/* eslint-enable @typescript-eslint/no-unnecessary-condition */

/**
 * The identity `kill(pid, 0)` is actually scoped to, with whitespace folded —
 * the body is whitespace-delimited.
 *
 * A HOSTNAME IS NOT A PROCESS-TABLE IDENTITY. Two containers with the same
 * pinned `--hostname` sharing a bind-mounted runs directory each probe their
 * OWN pid namespace for the other's pid, read a live holder as dead, and print
 * `rm <lock>` for it — the double teardown, via the guard that exists to
 * prevent it. The pid namespace's inode is what the probe is really about, so
 * it goes in the token wherever the kernel exposes it.
 *
 * Locks written by an older build carry the bare hostname and therefore no
 * longer match — which is the fail-closed answer: `refuse` classifies a host it
 * cannot match as "liveness unknown from here" and never marks it stale.
 */
function lockHost(): string {
  const host = hostname().replace(/\s+/g, "_") || "unknown-host";
  try {
    // "pid:[4026531836]" → "4026531836". Linux only; on macOS/BSD there is no
    // pid-namespace ambiguity for it to disambiguate.
    const ns = readlinkSync("/proc/self/ns/pid").replace(/\D/g, "");
    return ns === "" ? host : `${host}/${ns}`;
  } catch {
    return host;
  }
}

/**
 * `lockHost()` folded to a filename-safe token — BIJECTIVELY. A literal
 * underscore becomes `--`, and every byte outside `[A-Za-z0-9_]` — a literal
 * hyphen included — is escaped as `-XX` (its two-digit hex), so the fold is
 * reversible and two distinct hosts can never collide (`a/b` → `a-2f`,
 * `a-b` → `a-2d`, `a_b` → `a--`; the old charset fold sent both `/`, `.`,
 * and any other stranger to `_`).
 *
 * The COLLISION mattered because temp files carry this tag: their pid is
 * otherwise unqualified, `reapStaleTemps` probes THIS host's process table,
 * and on a shared runs directory it used to delete a remote invocation's
 * in-flight temp between its `fsync` and its `linkSync`. A tag that folds
 * distinct identities together re-enables exactly that accident.
 */
/** Exported alongside the other primitives; DF3.2's fleet lock imports only `claim`/`isAlive`. */
export function hostTag(): string {
  return lockHost().replace(/[^A-Za-z0-9_]|_/g, (ch) => (ch === "_" ? "--" : `-${ch.charCodeAt(0).toString(16).padStart(2, "0")}`));
}

/**
 * Same probe `RunRecordStore` uses for its stale temps (run-record.ts's
 * `isAlive`): signal 0 tests existence, EPERM means alive but not ours.
 * Duplicated rather than imported because that copy is module-private.
 *
 * Host-local by construction — only ever called for a body this host wrote.
 *
 * FAILS CLOSED: a pid this cannot PROVE dead is alive. `process.kill(1e11, 0)`
 * throws `ERR_OUT_OF_RANGE` — not an errno at all — and pid 0 signals the whole
 * process group, so both used to answer "not running" and send the operator to
 * `rm` a live holder's lock. ESRCH is the only proof of death there is; every
 * other outcome (EPERM, a range error, an errno this runtime invents) is a
 * failure to answer, and the rest of this module fails closed on exactly that.
 */
/** Exported for DF3.2's fleet lock (src/fleet/fleet-lock.ts) — additive only, no behavior change. */
export function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0 || pid > 0x7fff_ffff) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/**
 * Best-effort durability for the directory entry the link created.
 *
 * ponytail: a second copy of `fs-atomic.ts`'s exported `fsyncDir` — this module
 * is imported BY both fleet modules, so it can adopt the leaf without a cycle.
 * Upgrade trigger: the next time this file is in scope to touch.
 */
function fsyncDir(dir: string): void {
  let dfd: number | undefined;
  try {
    dfd = openSync(dir, "r");
    fsyncSync(dfd);
  } catch {
    // Not every platform/filesystem permits fsync on a directory handle; the
    // link itself is the mutual-exclusion boundary, the fsync only its durability.
  } finally {
    if (dfd !== undefined) {
      try {
        closeSync(dfd);
      } catch {
        // The descriptor is consumed either way (POSIX). This runs AFTER
        // `held.set` in acquire, so a throwing close used to fail an
        // already-claimed acquire with a raw errno — the caller classified the
        // invocation as failed while holding the lock. Same guard as claim's /
        // writeLockDirect's closes; fsync here is best-effort by design.
      }
    }
  }
}

/**
 * One Ctrl-C during teardown used to leave the lock on disk forever: every
 * later harvest/teardown of that run refused while the box and the API key
 * stayed live and billing. Release on the way out — EXCEPT past
 * `markRunLockDestructive`, see `releaseHeldRunLocks` — then exit with the
 * status the signal earned (128+n, not 0).
 *
 * Every listener comes OFF before the re-raise, not just ours. `once`'s implicit
 * removal takes only our handler and then re-raises, which relies on the default
 * TERMINATE disposition applying — and it does not while ANY other listener for
 * that signal is still registered (a test runner, an embedder, a wrapper). The
 * signal was swallowed there, with the lock already unlinked and the teardown
 * still in flight. A listener-free signal restores the default disposition, so
 * the re-raise really does kill the process — `process.exit(128+n)` would look
 * the same to a shell but reports a clean exit rather than a death by signal,
 * and `signalCode` is what the callers of a killed CLI actually read.
 *
 * PUT BACK, though, rather than `removeAllListeners`. This module is a library:
 * `scripts/sandbox-teardown.ts` exports `run()` and `acquireRunLock`, tests
 * import them, and embedders call them — so a permanent strip meant the first
 * lock any consumer acquired silently deleted its own SIGINT/SIGTERM handling
 * (graceful shutdown, coverage flush, `bun test` cleanup) for the rest of the
 * process. The removal is only needed for the length of the re-raise. On the
 * path that matters the restore never runs, because the process is already
 * dead; if the signal was blocked or ignored and we SURVIVE it, the releases
 * are undone (`rollbackReleasedClaims`) — a live invocation must not keep
 * running mid-teardown with its locks unlinked, which is the double-teardown
 * window that opening them before the raise used to leave behind. Fail-safe
 * direction: a failed rollback strands a lock an operator judges, never hands
 * the run free to the next verb.
 *
 * `process.on` plus the `unwinding` latch, not `once`: the handler stays
 * registered until a signal actually arrives, so a SECOND acquire after an
 * earlier signal is still covered (`signalsInstalled` latches, so `once` left
 * that lock with no handler at all), and the latch keeps a second delivery
 * mid-release from re-entering.
 *
 * SIGHUP and SIGQUIT are in the list for the same reason SIGINT is: their
 * default disposition TERMINATES, and a dropped ssh session or a closed
 * terminal is the most ordinary way an operator's teardown dies. `exit` covers
 * everything that is not a signal at all — a plain `process.exit()` reached
 * while the lock is held, an uncaught throw, an unhandled rejection. Since this
 * module never steals and neither an empty body nor a live pid is ever marked
 * stale, each of those paths used to strand the run against every later verb
 * with no automated way back.
 */
function installSignalRelease(): void {
  if (moduleState().signalsInstalled) return;
  moduleState().signalsInstalled = true;
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"] as const) {
    const onSignal = (): void => {
      if (moduleState().unwinding) return;
      moduleState().unwinding = true;
      // Snapshot BEFORE releasing: the rollback below must know every claim
      // this unwind dropped, including the successful ones (`releaseHeld...`
      // deletes entries as they succeed, so reading `held` afterwards sees
      // only the dirtily-failed leftovers).
      const preReleaseSnapshot = [...moduleState().held.entries()];
      // Ours goes for good (the `unwinding` latch already made it a no-op);
      // everyone else's is borrowed for the duration of the re-raise.
      process.removeListener(sig, onSignal);
      const others = process.listeners(sig);
      for (const listener of others) process.removeListener(sig, listener as () => void);
      releaseHeldRunLocks();
      try {
        process.kill(process.pid, sig);
      } catch (raiseErr) {
        // The re-raise itself failed (a seccomp filter or an LSM refusing
        // kill(2), say): the signal was NOT delivered, so nothing terminated.
        // Leaving `unwinding` set — and this handler off — would dead-letter
        // every later Ctrl-C; reset the latch, put EVERY listener back — ours
        // and each one borrowed for the re-raise, so the embedder/supervisor
        // handlers this module must not eat survive the failed raise too —
        // put the claims we just released BACK on disk, and surface the
        // failure — L1's rule is that locks come off only when termination is
        // proven.
        moduleState().unwinding = false;
        process.on(sig, onSignal);
        for (const listener of others) process.on(sig, listener as () => void);
        rollbackReleasedClaims(preReleaseSnapshot);
        writeStderr(
          `warning: could not re-raise ${sig} (${(raiseErr as Error).message}) — the releases above were rolled back and this invocation is STILL RUNNING with its locks restored\n`,
        );
        return;
      }
      // The raise landed with NO listeners registered for `sig`, so the
      // kernel's default TERMINATE disposition ends this process right here —
      // everything below runs only when it did NOT end anything, i.e. the
      // host's disposition blocked/ignored/caught the signal (an embedder, a
      // supervisor wrapper, a debugger). A survivor mid-teardown with its locks
      // already unlinked is exactly the double-teardown window L1 names, so the
      // releases are ROLLED BACK: each claim goes back under its own path, and
      // every later verb refuses on a live lock again — the module's standing
      // fail-safe posture (an operator judges a stranded lock) rather than the
      // fail-open alternative (the path left free). The borrowed listeners go
      // back on this path too: a supervisor that blocked the signal still
      // expects its own handler to fire on the NEXT delivery, and a permanent
      // strip here would have eaten it for the rest of the process.
      rollbackReleasedClaims(preReleaseSnapshot);
      moduleState().unwinding = false;
      process.on(sig, onSignal);
      for (const listener of others) process.on(sig, listener as () => void);
      writeStderr(
        `warning: ${sig} arrived while this process's disposition is blocked or ignored (an embedder or supervisor wrapper) and did NOT terminate it\n` +
          `next: the run locks released above were PUT BACK — stop the embedder or SIGKILL this process instead of relying on ${sig}\n`,
      );
    };
    process.on(sig, onSignal);
  }
  // Sync by construction (`releaseHeldRunLocks` is all *Sync calls) — an async
  // release here would never run. Releasing an empty `held` is a no-op, so this
  // costs nothing on the normal path where the caller's finally already released.
  process.on("exit", releaseHeldRunLocks);
}

/**
 * Locks whose critical section is past the point of no return — the box is
 * being destroyed, the key revoked, the record closed.
 *
 * The automatic release above is for the interval where NOTHING has been
 * mutated yet; past this mark it is the opposite of safe. A Ctrl-C after
 * `driver.destroy()` but before the record closes would hand the run straight
 * to the next teardown, which re-runs against a half-torn-down run — and
 * `ledger.close()`, where the reservation is flushed, was skipped on the way
 * out too. This module's own promise is that "a stale lock means an uncertain
 * teardown state, which is exactly the moment an operator — not a heuristic —
 * should decide", so leave it for the operator and say so on stderr.
 *
 * The mark protects the STATE, not just the signal path. It used to be
 * consulted ONLY by `releaseHeldRunLocks`, while `releaseRunLock` deleted it
 * and released unconditionally — so a teardown that destroyed the box and THEN
 * threw hit its caller's `finally { releaseRunLock(lock) }` and handed a
 * half-torn-down run to the next retry with a clean lock. An interrupt and a
 * throw leave the run in the same uncertain state; only the exit path differed.
 * `releaseRunLock` refuses the same way now, and the mark is cleared by the
 * caller that KNOWS the destructive phase completed.
 */
export function markRunLockDestructive(lock: string): void {
  moduleState().destructive.add(lock);
}

/**
 * The destructive phase finished — the box is gone, the key revoked, the record
 * closed — so `lock` is an ordinary lock again and both release paths may drop
 * it automatically.
 *
 * Called by the CLI on its SUCCESS path only. It is deliberately not something
 * `releaseRunLock` can infer: from inside the release, "the caller reached its
 * finally" looks identical whether `teardownSandbox` returned or threw, and
 * that is the entire distinction the mark exists to draw.
 */
export function clearRunLockDestructive(lock: string): void {
  moduleState().destructive.delete(lock);
}

/**
 * Full write to fd 2, the same loop `scripts/fleet.ts` uses for its own
 * diagnostics. `console.error` bypassed that sink: its line could interleave
 * with a partially written JSON log line, and a short write silently truncated
 * the remediation an operator has to follow.
 *
 * BEST-EFFORT, because of where it runs: `releaseHeldRunLocks` is a
 * `process.on("exit")` handler, so anything that hangs or throws here replaces
 * an orderly exit with a wedge or an unhandled error — and the release it is
 * reporting on has already happened either way. An fd 2 the caller left
 * non-blocking (a CI runner, a wrapper) is the case: `writeSync` raises EAGAIN
 * there, and a zero-length return would spin this loop forever. Both give up on
 * the rest of the line instead.
 */
function writeStderr(s: string): void {
  const buf = Buffer.from(s, "utf8");
  let off = 0;
  try {
    while (off < buf.length) {
      const n = writeSync(2, buf, off, buf.length - off);
      if (n <= 0) return;
      off += n;
    }
  } catch {
    // Diagnostics are not worth an unhandled throw out of an exit handler.
  }
}

/**
 * Put claims `releaseHeldRunLocks` just dropped back on disk (L1's
 * survived-signal path: the re-raise did not terminate the process, so the
 * releases it caused are no longer safe to have happened). Only entries still
 * in `held` are restored, which is exactly the ones whose release FAILED
 * dirty — a successful release already removed its own entry.
 *
 * `claim` is exclusive, so a contender that took the path between our release
 * and our rollback simply wins: our re-claim returns false, we keep the entry,
 * and our next release/exit finds the mismatch branch and drops it.
 */
function rollbackReleasedClaims(snapshot: [string, string][]): void {
  const state = moduleState();
  for (const [lock, body] of snapshot) {
    // Past the point of no return — `releaseHeldRunLocks` never dropped these,
    // so putting their (possibly released-by-us?) bodies back is not ours to
    // decide here either; they keep the operator-judgment posture.
    if (state.destructive.has(lock)) continue;
    try {
      claim(lock, body);
      // Re-registered ONLY if this process does not still hold it (a dirty
      // failed release leaves the entry in place — claimedByUs made the claim
      // succeed against our own surviving file, so refresh it).
      state.held.set(lock, body);
    } catch {
      // Best-effort by construction: runs inside a signal handler. An entry
      // that could not be reclaimed but IS absent from `held` gets re-added so
      // the exit handler keeps owning its fate rather than dropping it.
      if (!state.held.has(lock)) state.held.set(lock, body);
    }
  }
}

/** Release every lock this process still holds, reporting failures to stderr. */
export function releaseHeldRunLocks(): void {  for (const lock of [...moduleState().held.keys()]) {
    if (moduleState().destructive.has(lock)) {
      writeStderr(
        `!! lock-held: ${lock} was NOT released — this invocation was interrupted after it began destroying the run\nnext: check the run's box, key and record before anything else touches it; rm ${lock} only once you know the teardown state\n`,
      );
      continue;
    }
    try {
      releaseRunLock(lock);
    } catch (e) {
      writeStderr(
        `!! lock-release-failed: could not release ${lock}: ${(e as Error).message}\nnext: rm ${lock} by hand once no other invocation holds it — until then every later teardown of this run refuses\n`,
      );
    }
  }
}

/** `<pid> <host> <ISO> <nonce>`, or the pre-host `<pid> <ISO> <nonce>` layout. */
function parseLockBody(body: string): { pid?: string; host?: string; at: number } {
  const [pid, second, third] = body.trim().split(/\s+/);
  // The discriminator is the shape of field 2: only `toISOString()` output can
  // be there in the old layout, and no hostname matches it.
  const preHost = /^\d{4}-\d{2}-\d{2}T/.test(second ?? "");
  return {
    pid,
    host: preHost ? undefined : second,
    at: Date.parse((preHost ? second : third) ?? ""),
  };
}

/**
 * Past this, a live pid holding the lock is more likely a recycled pid than a
 * running invocation: harvest and teardown are minutes of work, not hours.
 * Only ever widens the refusal's wording — never a steal, never a TTL.
 */
const IMPLAUSIBLE_HOLD_S = 6 * 60 * 60;

/**
 * Generous NTP slop. A `createdAt` further in the FUTURE than this is not a
 * clock the holder host can reasonably disagree by — it is a holder whose
 * clock leads this one, and "held 0s" would be a lie for as long as the skew
 * runs.
 */
const CLOCK_SKEW_S = 5 * 60;

/**
 * Describe the invocation currently holding `lock` for the refusal message, or
 * `undefined` when the lock VANISHED between the caller's EEXIST and this read
 * — a free run, not an unreadable one, so the caller retries rather than
 * printing an `rm` for a path that no longer exists.
 */
function refuse(lock: string, holder: string): RunLockedError | undefined {
  let body = "";
  // An unreadable lock leaves `body` empty too, and "empty" is a REAPABLE
  // classification below. The two must not collapse: a lock we merely cannot
  // read (EACCES, EIO) is the one whose holder is most unknown, and telling an
  // operator to rm it is the fail-open answer this module never gives.
  let readable = false;
  let readErrno: string | undefined;
  try {
    body = readFileSync(lock, "utf8").trim();
    readable = true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return undefined;
    readErrno = code ?? (e as Error).message;
    // present but unreadable — fail closed below with what we do know
  }
  // PRESENT but UNREADABLE (EACCES, EIO): the holder is maximally unknown, so
  // the rendering must not fake a body ("holder unknown, lock body \"\"" was
  // asserting bytes that were never seen) and must not print the template's
  // rm-for-a-proven-gone-holder advice — there is no proof anybody is gone.
  if (!readable) {
    const err = new RunLockedError(
      lock,
      `unreadable from this invocation (${readErrno}), holder maximally unknown`,
      holder,
    );
    (err as { remediation: string }).remediation =
      `do NOT remove it on this evidence alone — fix the read failure first (${readErrno}): check permissions/ownership of ${lock} and every directory on its path, or run this verb as a user that can read it; once it reads, re-run and judge by what the body says`;
    return err;
  }
  // An EMPTY body is not an unparseable one. Nothing ever writes a lock without
  // a body, so the ways to observe one are `writeLockDirect`'s create-to-write
  // window (a creator SIGKILLed/OOM-killed in it; every throw in there removes
  // the lock itself) and a stray `touch <runId>.lock`. Rendered as "holder
  // unknown" it became a lock to WAIT on, nothing in this module steals or
  // expires, and `reapStaleTemps` matches only `.tmp`: the run refused forever
  // while the box and the key kept billing. Name it and give the exact `rm`.
  //
  // NOT `stale`, though. An empty body PROVES NOTHING — least of all that its
  // creator is dead. `writeLockDirect` is the fallback for the filesystems
  // where hard links do not work at all (SMB, FUSE, NFS bind mounts — see
  // `claim`'s EPERM/ENOSYS rationale), i.e. exactly the ones where create,
  // write and fsync each round-trip a network and the "instant" is not one. A
  // live contender sitting in that window is the ordinary case, and `stale` is
  // the MACHINE-READABLE claim that no live process holds the lock: it drives
  // the "rm it, then re-run" remediation, which is the double teardown printed
  // as advice. Say what is known in the prose and leave the flag alone.
  if (readable && body === "") {
    // Dedicated wording, not the base template plus a note: the template's
    // "wait for that invocation to finish — or, only if <holder unknown> is
    // gone: rm" fought the appended "rm it only once you have confirmed …",
    // telling the operator to rm and never-rm in the same breath. The stale
    // flag stays false (an empty body PROVES NOTHING — see above), so the
    // machine-readable classification is untouched; only the prose stops
    // contradicting itself.
    const err = new RunLockedError(lock, "an empty lock, holder unknown", holder);
    // `remediation` is readonly to its consumers; this module OWNS the class,
    // so the dedicated wording is assigned through a writable view rather than
    // widening the public property.
    (err as { remediation: string }).remediation =
      `Wait and re-check first — an empty lock means either a creator that died between creating it and writing its body, or one still inside that window (on a filesystem without hard links the write and its fsync are not instant). rm ${lock} only once you have confirmed no harvest or teardown of this run is running anywhere that shares this directory`;
    return err;
  }
  const { pid, host, at } = parseLockBody(body);
  if (!/^\d+$/.test(pid ?? "") || Number.isNaN(at)) {
    return new RunLockedError(lock, `holder unknown, lock body ${JSON.stringify(body)}`, holder);
  }
  const rawAgeS = Math.round((Date.now() - at) / 1000);
  const age = Math.max(0, rawAgeS);
  // A holder host whose clock LEADS this one writes creation times in the
  // future; `Math.max(0, …)` clamped those to "held 0s" for as long as the
  // skew ran — hours or days printed as an instant — and the implausible-hold
  // hint below could not fire because 0 is never past any threshold. Past the
  // skew bound, name the skew instead of the fake age and let the hint fire;
  // the lock is still NEVER marked stale on this evidence alone (fail-closed).
  const futureS = rawAgeS < -CLOCK_SKEW_S ? -rawAgeS : 0;
  const ageText =
    futureS > 0
      ? `held ${age}s (its createdAt is ${futureS}s in the future — the holder host's clock leads this one)`
      : `held ${age}s`;
  // A pid is only meaningful on the host that minted it. Probing our own
  // process table for a foreign host's pid returns either a false "not running"
  // — and the remediation then tells the operator to rm a LIVE holder's lock,
  // re-opening the double teardown — or a false "alive" via pid reuse. Say
  // "unknown" instead, and never mark a foreign lock stale.
  //
  // A host we cannot MATCH counts as foreign, including the `undefined` a
  // pre-host body parses to. Back-compat that quietly opts old locks out of the
  // guard is back-compat that re-opens the bug the guard was added for.
  if (host !== lockHost()) {
    return new RunLockedError(
      lock,
      host === undefined
        ? `pid ${pid} from a lock written before the host field existed, liveness unknown from here, ${ageText}`
        : `pid ${pid} on host ${host}, liveness unknown from here, ${ageText}`,
      holder,
      false,
      // Same honesty this branch demands of the same-host one: a hostname can
      // CHANGE (a recreated container, a dhcp renewal), so "another host" does
      // not always mean another machine — but this module will not probe or
      // clear a lock whose host it cannot match, so long silence plus a ps on
      // the box is the operator's evidence, stated as guidance rather than
      // acted on. Behavior unchanged: still refused, still not stale.
      host === undefined
        ? ""
        : ` — held ${age}s already. Hostnames change (a recreated container or a dhcp renewal can leave THIS box matching nothing): if ${host} looks like this machine under an older name and no harvest or teardown of this run is running anywhere sharing this directory, that long silence is the evidence — check \`ps -p ${pid}\` on the box; this module will not probe or clear a lock whose host it cannot match`,
    );
  }
  // OUR OWN pid, on our own host, in a body we did not write (`claimedByUs`
  // compares the nonce and sends the mismatch here). `acquireRunLock` refuses a
  // lock this process actually holds up front — `held.has(lock)` — so by the
  // time a claim gets this far, this process does NOT consider itself the
  // holder. Two ways to arrive, and neither is re-entrancy: a predecessor was
  // SIGKILLed and the OS recycled its pid onto us, or an earlier claim of ours
  // outlived a failed release. `claimedByUs` used to raise
  // RunLockReentrantError for both, whose remediation ("release the lock before
  // acquiring it again") is unfollowable when `held` is empty and there is
  // nothing to release — and the run stayed wedged against every later harvest
  // and teardown while the box and the key billed.
  //
  // Marked stale, and this is the ONE place the module can prove it: a pid is
  // unique among the live processes of one process table, and this one is ours,
  // so it cannot also name a live holder. `isAlive` would say "yes" (it is us)
  // and send the operator to wait on themselves forever.
  if (pid === String(process.pid)) {
    // A matching pid alone does not PROVE the holder is dead: the same runs
    // directory reachable under two spellings (a symlinked path, a case-
    // insensitive mount) gives one live lock two resolved paths, so the
    // `held.has(lock)` guard in `acquireRunLock` missed and this "claim" is
    // our OWN live lock seen through an alias — marking it stale advises an
    // `rm` of a lock we hold mid-destruction. Before calling it provably
    // stale, require realpath identity with an entry this process actually
    // holds; anything unprovable (the lock or a held entry unreadable to
    // realpath) reads as a LIVE holder. Fail-closed kept: only the proven-
    // unheld case is ever marked stale.
    let provenUnheld = false;
    try {
      const real = realpathSync(lock);
      provenUnheld = true;
      for (const h of moduleState().held.keys()) {
        try {
          if (realpathSync(h) === real) {
            provenUnheld = false;
            break;
          }
        } catch {
          // A vanished or unreadable held entry proves nothing either way.
        }
      }
    } catch {
      // The lock itself cannot be resolved to a real path — no proof of death.
    }
    if (!provenUnheld) {
      return new RunLockedError(
        lock,
        `pid ${pid} is this invocation's own pid and the lock is live under another spelling of the same directory, ${ageText}`,
        holder,
        false,
        " — the run lock is not re-entrant and this process HOLDS it (reached through a different path spelling): release that claim instead of removing this file",
      );
    }
    return new RunLockedError(
      lock,
      `pid ${pid} is this invocation's own pid but the claim is not one it registered, ${ageText}`,
      holder,
      true,
      ` — either a dead predecessor's pid was recycled onto this process, or an earlier claim of this process outlived a failed release. No live invocation can hold it: this pid is ours. rm ${lock}, then re-run`,
    );
  }
  // PID liveness, not just the number: without it the printed remediation
  // ("only if that pid is gone") is unfollowable, and pid reuse makes it wrong.
  const alive = isAlive(Number(pid));
  const who = `pid ${pid}${alive ? "" : " is not running"}, ${ageText}`;
  // Pid reuse cuts BOTH ways, and this is the direction the comment above does
  // not cover: after a SIGKILL the OS can recycle the holder's pid onto an
  // unrelated process, `isAlive` reads that stranger as the holder, and the
  // remediation then tells the operator to wait on a process that will never
  // release. No steal and no TTL — this module's no-steal property is
  // load-bearing, and a timeout would resurrect the double teardown it exists
  // to prevent. Make the DIAGNOSIS honest instead: the body already carries
  // `createdAt`, so an implausible hold is detectable, and a process start time
  // later than the lock's proves the pid is not the holder.
  //
  // A future-dated body gets the same hint from the other side (FR10): with
  // createdAt ahead of this host's clock the age is unknowable here, so "wait"
  // is advice about an unmeasurable interval — point at `ps` against NOW.
  const note =
    alive && futureS > 0
      ? ` — note: the lock claims creation ${futureS}s ahead of this host's clock, so its hold length cannot be judged from here. Check \`ps -p ${pid} -o lstart=,args=\`: if that process started after ${new Date(Date.now()).toISOString()} it is likely a recycled pid, not the holder`
      : alive && age > IMPLAUSIBLE_HOLD_S
        ? ` — note: held ${age}s, far longer than any invocation runs. If its holder was SIGKILLed the OS may have recycled pid ${pid} onto an unrelated process: check \`ps -p ${pid} -o lstart=,args=\`, and if that process started after ${new Date(at).toISOString()} it is NOT the holder and the lock is safe to rm`
        : "";
  return new RunLockedError(lock, who, holder, !alive, note);
}

/**
 * The claim-temp suffix. Deliberately NOT `.tmp`: `RunRecordStore`'s own
 * constructor sweep (`cleanStaleTemps`) runs in THIS directory on every CLI
 * start and treats every `*.tmp` whose pid does not parse as immediately
 * removable — a run-lock claim temp carries `<hostTag>.<pid>` so its second-to-
 * last dot-separated field is the tag, not the pid, which parses to NaN there
 * and got the in-flight temp rmSync'd by a store built on another HOST while
 * the claim was mid-link. A distinct suffix takes these temps out of that
 * sweep's reach entirely, which no host qualification inside the name could
 * achieve without editing the foreign module.
 *
 * `reapStaleTemps` here matches only this shape; `.rescue` keeps its separate,
 * unswept shape as before.
 */
const CLAIM_TEMP_SUFFIX = ".lktmp";

/**
 * Cap on directory entries scanned per temp sweep. The scan exists to clear
 * THIS run's dead claims' litter — bounded per-run work on a shared store, not
 * an O(n) walk of thousands of unrelated records on every acquire. Sweeps are
 * advisory hygiene: anything past the cap stays until a later acquire whose
 * entries sort earlier, and correctness was never carried by completeness
 * (`live` temps are skipped by design).
 */
const REAP_SCAN_CAP = 512;

/** Temps swept at most once per process-epoch-minute, not once per acquire. */
const REAP_SWEEP_TTL_MS = 60_000;

const reapTtlCache = new Map<string, number>();

/**
 * Reap `<runId>.lock.<hostTag>.<pid>.<hex>.lktmp` left by a process that died
 * between the temp's creation and its unlink (SIGKILL, ENOSPC, power loss).
 * Nothing else removes them and they accumulate in the same directory the
 * record/bundle listings glob over. Only temps whose recorded pid is gone are
 * removed — a live pid's temp is mid-acquire.
 */
function reapStaleTemps(runsDir: string, runId: string): void {
  const prefix = `${runId}.lock.`;
  // A pid is only meaningful on the host that minted it — the same reason
  // `refuse` refuses to probe a foreign lock, and this sweep had NO host check
  // at all. On a shared runs directory an unqualified probe read a remote
  // invocation's live pid as dead and `rmSync`'d its in-flight temp between the
  // `fsync` and the `linkSync`. Temps carry the host tag; one that does not
  // match OURS (another host's, or an older build's) is never ours to reap.
  const mine = `${hostTag()}.`;
  const lastSweep = reapTtlCache.get(`${runsDir}\x00${runId}`);
  if (lastSweep !== undefined && Date.now() - lastSweep < REAP_SWEEP_TTL_MS) return;
  reapTtlCache.set(`${runsDir}\x00${runId}`, Date.now());
  let names: string[];
  try {
    names = readdirSync(runsDir);
    if (names.length > REAP_SCAN_CAP) names = names.slice(0, REAP_SCAN_CAP);
  } catch {
    return; // the acquire below reports a missing/unreadable directory properly
  }
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith(CLAIM_TEMP_SUFFIX)) continue;
    const rest = name.slice(prefix.length);
    if (!rest.startsWith(mine)) continue;
    const pid = Number(rest.slice(mine.length).split(".")[0]);
    if (!Number.isInteger(pid) || pid <= 0 || isAlive(pid)) continue;
    try {
      rmSync(join(runsDir, name), { force: true });
    } catch {
      // Best effort: a temp we cannot remove is litter, never a correctness bug.
    }
  }
}

/**
 * Did the EEXIST we just got come from OUR OWN link landing?
 *
 * `link(2)` can report EEXIST for a link that SUCCEEDED: NFS retransmits the
 * request when the reply is lost, and the server answers the retry with EEXIST
 * because the entry — the one it created for us — is already there. Returning
 * false there sent `refuse` to read the lock, find OUR pid, `isAlive` say yes,
 * and throw "another fleet invocation holds it … wait for that invocation to
 * finish" — about ourselves, forever.
 *
 * The body carries a per-attempt nonce, so "the lock holds exactly the bytes we
 * just wrote" is proof the link landed. Anything else is not ours, INCLUDING a
 * body carrying our own pid and host with a different nonce: that used to throw
 * `RunLockReentrantError` from here, which is wrong twice over — a pid the OS
 * recycled onto us from a SIGKILLed predecessor produces the identical body,
 * and genuine re-entrancy never reaches this function because `acquireRunLock`
 * refuses on `held.has(lock)` before it claims. `refuse` classifies the
 * pid-matches-us case (it can prove no live invocation holds such a lock);
 * everything else is genuine contention.
 */
function claimedByUs(lock: string, body: string): boolean {
  let onDisk = "";
  try {
    onDisk = readFileSync(lock, "utf8");
  } catch {
    // Unreadable or already gone — no proof it is ours, so treat it as a
    // stranger's and let the caller refuse (which re-reads and reports).
    return false;
  }
  return onDisk === body;
}

/**
 * Create `lock` holding `body`, exclusively. Returns false when the path is
 * already claimed; every other failure throws with its errno intact.
 *
 * `link(2)` from a complete, fsynced temp rather than O_EXCL-then-write: link
 * is equally exclusive and equally atomic, but the file is already whole when
 * it appears, so a concurrent reader can never observe an empty body and report
 * "holder unknown".
 *
 * Not every filesystem HAS hard links, though: FUSE and overlay mounts, some
 * macOS Docker bind-mount configs, exFAT and SMB shares return EPERM / ENOSYS /
 * EOPNOTSUPP from `link(2)` rather than EEXIST. That used to escape as a raw
 * errno with no remediation, making every harvest and teardown on such a host
 * permanently impossible — so fall back to O_EXCL, which works everywhere.
 *
 * ponytail: the fallback re-opens the empty-body window the link avoids (a
 * reader between create and write sees ""), which `refuse` already renders as
 * "holder unknown". Correct, just less informative — and only on filesystems
 * that leave no other option.
 */
/** Exported for DF3.2's fleet lock (src/fleet/fleet-lock.ts) — additive only, no behavior change. */
export function claim(lock: string, body: string): boolean {
  // Host tag BEFORE the pid: the pid in this name is what `reapStaleTemps`
  // probes, and a pid without the host that minted it is not a pid.
  const tmp = `${lock}.${hostTag()}.${process.pid}.${randomBytes(4).toString("hex")}${CLAIM_TEMP_SUFFIX}`;
  let fd: number | undefined;
  try {
    // Inside the try (not before it): a missing runs directory, EACCES, or a
    // pid+nonce collision is cleaned up and classified like every other failure
    // here instead of escaping around the cleanup.
    fd = openSync(tmp, "wx", 0o600);
    writeFileSync(fd, body);
    fsyncSync(fd);
    // Cleared BEFORE the call, not after: `close(2)` consumes the descriptor
    // whether it returns or fails (POSIX), so a throwing close still leaves the
    // number free for reuse — closing it again could land on a stranger's handle.
    const open = fd;
    fd = undefined;
    closeSync(open);
    try {
      linkSync(tmp, lock);
      return true;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "EEXIST") return claimedByUs(lock, body);
      // ONLY the errnos the paragraph above enumerates fall back. Every other
      // errno — ENOSPC, EIO, EACCES, EDQUOT — is a link that failed for a
      // reason `openSync(lock, "wx")` will hit too, and if the link had in fact
      // landed the fallback's own EEXIST reported "already claimed" against the
      // lock we just created: the same permanent wedge from the other side.
      if (code === "EPERM" || code === "ENOSYS" || code === "EOPNOTSUPP") return writeLockDirect(lock, body);
      throw e;
    }
  } finally {
    // Guarded, for the reason `writeLockDirect`'s own catch states: this runs
    // while the original error is in flight, and an ENOSPC/EIO on the write or
    // the fsync is exactly the failure whose `close(2)` throws EIO on the same
    // dying device. An unguarded `closeSync` here REPLACED the caller's errno
    // with a close error and skipped the `rmSync` below, leaking the temp — the
    // hazard `writeLockDirect` names this function as avoiding. It does now.
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // The descriptor is consumed either way (POSIX); the original error is
        // the useful one and it is still in flight.
      }
    }
    try {
      rmSync(tmp, { force: true });
    } catch {
      // The lock may already be OURS at this point; throwing here would abandon
      // it with nothing registered to release it. reapStaleTemps sweeps later.
    }
  }
}

/**
 * The no-hard-links fallback: O_EXCL create, then write.
 *
 * Unlike `claim`'s link path, the create here IS the lock — so every failure
 * after it has to undo it. An ENOSPC/EIO/EDQUOT on the write or the fsync
 * otherwise leaves `<runId>.lock` on disk EMPTY, with nothing registered to
 * release it: the throw escapes past `held.set`, `refuse` renders `""` as
 * "holder unknown", and "holder unknown" is never marked stale. Nothing in this
 * module steals and `reapStaleTemps` only sweeps temps, so every later
 * harvest/teardown of that run refuses FOREVER while the box and the key keep
 * billing. Removing it on the way out is the whole of the fix.
 */
/** Exported alongside the other primitives; DF3.2's fleet lock imports only `claim`/`isAlive`. */
export function writeLockDirect(lock: string, body: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(lock, "wx", 0o600);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw e;
  }
  try {
    writeFileSync(fd, body);
    fsyncSync(fd);
    // Cleared BEFORE the call, as in `claim`: `close(2)` consumes the descriptor
    // whether it returns or fails (POSIX), so a throwing close still leaves the
    // number free for reuse — closing it again could land on a stranger's handle.
    const open = fd;
    fd = undefined;
    closeSync(open);
    return true;
  } catch (e) {
    // Both cleanups swallow their own failure. They run while `e` is in flight,
    // and the caller needs the errno that actually broke the write — a `finally
    // { closeSync(fd) }` that threw EIO on the same failing device would REPLACE
    // it, which is the mirror image of the hazard `claim` avoids above.
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // The descriptor is consumed either way; the errno below is the useful one.
      }
    }
    try {
      rmSync(lock, { force: true });
    } catch {
      // Wedged lock we cannot clear — no worse than before, and `e` still names why.
    }
    throw e;
  }
}

/**
 * The brand on a lock path THIS process provably acquired. `declare`d, not
 * `const`: the brand exists only in the type system, so it emits no runtime
 * value and cannot be forged — the symbol is module-private and there is no
 * exported cast helper. A `RunLockHandle` IS a `string`, so every consumer
 * site keeps compiling unchanged.
 *
 * The point is the release-side primitives (`releaseRunLock`,
 * `markRunLockDestructive`, `clearRunLockDestructive`): a hand-joined
 * `resolve(runsDir, …)` string passed to one of those no-ops or refuses
 * silently, and a typo'd path held under a different spelling is exactly the
 * lock an operator finds stranded. Typed as a handle, a caller can only reach
 * the primitives with a path this process actually claimed.
 */
declare const RUN_LOCK_BRAND: unique symbol;

export type RunLockHandle = string & { readonly [RUN_LOCK_BRAND]: true };

/**
 * Claim `<runsDir>/<runId>.lock` for the duration of one invocation, writing
 * `<pid> <host> <createdAt-ISO> <nonce>` so a refused invocation can name the
 * holder and so `releaseRunLock` can prove the lock it unlinks is still ours.
 *
 * Two concurrent invocations for the same run both pass the closedAt gate
 * inside harvest/teardown (a check-then-act) and then double-revoke,
 * double-destroy and interleave writes to the fixed `<runId>.bundle` /
 * `<runId>-artifacts` paths. Unlike the store's per-write lock, this one never
 * steals: a stale lock means an uncertain teardown state, which is exactly the
 * moment an operator — not a heuristic — should decide.
 *
 * ponytail: library callers bypass the lock — the CLIs are the operator surface.
 * Upgrade trigger: an embedder (not a CLI) becomes a supported caller.
 */
export function acquireRunLock(runsDir: string, runId: string, holder = "invocation"): RunLockHandle {
  // The id is joined into a filesystem path: validate BEFORE the join, on the
  // same grammar the record store enforces, not after the path exists.
  assertValidRunId(runId);
  // FIRST, before a lock can exist: a SIGINT (or a throw) after the link but
  // before the handler was registered left `<runId>.lock` on disk with nothing
  // to release it, and this module never steals — every later harvest/teardown
  // of that run refused forever while the box and the key stayed live and
  // billing. Releasing an empty `held` is a no-op, so installing early is free.
  installSignalRelease();
  // `resolve`, not `join`: `held` is keyed on this string, and a relative
  // `runsDir` made `/srv/runs` and a `runs` typed from `/srv` two keys for ONE
  // file — the second acquire then refused with "wait for that invocation to
  // finish", naming us, which is the message `RunLockReentrantError` was added
  // to eliminate. An absolute path is also the one an operator can paste into
  // the `rm` the refusal prints.
  const lock = resolve(runsDir, `${runId}.lock`);
  if (moduleState().held.has(lock)) throw new RunLockReentrantError(lock);
  reapStaleTemps(runsDir, runId);
  // Two attempts, not a loop: the second covers a holder that finished between
  // our EEXIST and refuse()'s read (the lock is genuinely free again). A third
  // contender taking it in that same window is real contention, and the refusal
  // it produces is the truthful answer.
  for (let attempt = 0; attempt < 2; attempt++) {
    const body = `${process.pid} ${lockHost()} ${new Date().toISOString()} ${randomBytes(4).toString("hex")}\n`;
    if (claim(lock, body)) {
      // Registered the instant the lock is ours, BEFORE the fsync: everything
      // after this point can throw or be interrupted, and an unregistered lock
      // is one nothing will ever release.
      moduleState().held.set(lock, body);
      fsyncDir(runsDir);
      // The ONLY cast in scripts/ allowed to mint a handle (gate R3): `lock`
      // is the path this function just claimed and registered, which is the
      // whole of what the brand asserts.
      return lock as RunLockHandle;
    }
    const refusal = refuse(lock, holder);
    if (refusal !== undefined) throw refusal;
  }
  throw new RunLockedError(lock, "the lock is being taken and released repeatedly", holder);
}

/**
 * The acquire line DF2.11's Observability Contract requires of every new
 * wrapper site: one structured JSON line per `withRunLock` acquire attempt, to
 * stderr — this module's only log sink (`writeStderr`), kept dependency-free,
 * and best-effort like every other diagnostic here. Field shape is the
 * contract's, verbatim; `requestId` is threaded by the caller through
 * `opts.requestId` and falls back to `-` where a wrapper site has none.
 *
 * `outcome ∈ acquired | refused-busy | refused-stale`. The stale flavor is read
 * off `RunLockedError.stale` — the flag that already drives the
 * `rm`-then-re-run advice — so the classification is the same machine-readable
 * claim the refusal prose makes, not a substring sniff of it. A
 * `RunLockReentrantError` or a raw errno out of `claim` is an acquire that did
 * not settle, and lands in `refused-busy`, the contract's only other refusal.
 */
type AcquireOutcome = "acquired" | "refused-busy" | "refused-stale";

function logRunLockAcquire(
  requestId: string,
  runId: string,
  holder: string,
  outcome: AcquireOutcome,
  durationMs: number,
): void {
  writeStderr(`${JSON.stringify({ requestId, runId, operation: "run-lock.acquire", holder, outcome, durationMs })}\n`);
}

/**
 * Acquire the run lock, run `fn` under it, and release on the way out — the
 * acquire/mark/clear/release dance the CLIs hand-roll around their own
 * `try`/`finally`, in one place so the posture cannot drift per caller.
 *
 * The release posture is exactly the module's three observable states:
 *
 *  - `fn` resolved → the mark (if any) is cleared and the lock is released;
 *    the next verb for the same run acquires freely.
 *  - `fn` threw, non-destructive → the lock is released normally. Nothing was
 *    mutated, so the uncertainty the destructive mark exists to capture has
 *    not begun.
 *  - `fn` threw past `destructive: true` → NEITHER the mark nor the lock file
 *    is touched. `releaseRunLock` would refuse the release anyway, and the
 *    operator line comes from `releaseHeldRunLocks` on the way out — an
 *    interrupted destructive window stays an operator decision.
 *
 * `fn` receives the handle, so its body can reach the release primitives only
 * with the lock this invocation actually holds.
 */
export async function withRunLock<T>(
  runsDir: string,
  runId: string,
  holder: string,
  fn: (handle: RunLockHandle) => Promise<T>,
  opts: { destructive?: boolean; requestId?: string } = {},
): Promise<T> {
  // One contract log line per acquire attempt (Observability Contract, DF2.11):
  // emitted at settle — the moment the acquire returned or threw — so a refusal
  // is observable even when the caller swallows the throw. `durationMs` is the
  // acquire's own span; `fn`'s runtime belongs to the caller's own telemetry.
  const requestId = opts.requestId ?? "-";
  const acquireStartedAt = Date.now();
  let lock: RunLockHandle;
  try {
    lock = acquireRunLock(runsDir, runId, holder);
  } catch (e) {
    logRunLockAcquire(
      requestId,
      runId,
      holder,
      e instanceof RunLockedError && e.stale ? "refused-stale" : "refused-busy",
      Date.now() - acquireStartedAt,
    );
    throw e;
  }
  logRunLockAcquire(requestId, runId, holder, "acquired", Date.now() - acquireStartedAt);
  const destructive = opts.destructive === true;
  if (destructive) markRunLockDestructive(lock);
  // Latched AFTER `fn` resolves, never inferred in the `finally`: "the callback
  // returned" is the distinction the whole posture turns on, and a finally
  // cannot see it on its own — the same reason `releaseRunLock` cannot infer
  // success from being reached (see `clearRunLockDestructive`).
  let completed = false;
  // The release dance runs exactly once, from whichever arm settles the call —
  // never from a `finally`, so a failing release can neither overwrite `fn`'s
  // in-flight error (the failure mode noUnsafeFinally names) nor dead-code the
  // arm that follows.
  let finished = false;
  const finish = (): void => {
    if (finished) return;
    finished = true;
    // A throw past the destructive mark leaves BOTH the mark and the lock file
    // in place — the operator-judgment posture, delivered by not calling rather
    // than by calling and being refused.
    const leaveForOperator = destructive && !completed;
    if (leaveForOperator) return;
    // Success only: the clear is what un-refuses the release below (the mark's
    // own contract — never cleared as a side effect of releasing).
    if (destructive) clearRunLockDestructive(lock);
    // A failing release must never MASK the callback's outcome: when `fn`
    // threw, its error is the primary result (the held-map entry stays, so
    // `releaseHeldRunLocks` still retries at exit); when `fn` succeeded, the
    // release failure IS this invocation's failure and propagates from the
    // success arm.
    try {
      releaseRunLock(lock);
    } catch (e) {
      if (!completed) {
        writeStderr(
          `run-lock: release of ${lock} failed while the callback was already failing — the callback's error is reported instead; the lock stays held and releaseHeldRunLocks retries at exit (${String(e)})`,
        );
      } else {
        throw e;
      }
    }
  };
  try {
    const result = await fn(lock);
    completed = true;
    finish();
    return result;
  } catch (e) {
    finish();
    // The leave-for-operator arm: `completed` is still false here (it latches
    // only on `fn` resolving), so a `destructive` throw is exactly the
    // interrupted destructive window whose lock and mark were left on disk.
    // The reaper's generic failure advice ("re-run the sweep") dead-ends on
    // that lock — every re-run refuses until a human clears it — so the error
    // itself carries the correction. Same instance, never a wrap: the callers
    // classify the ORIGINAL error (`instanceof RunLockedError` in the reaper,
    // `TimeoutError` in fanout). `RunLockedError` cannot reach this arm — its
    // acquire refusal throws before `markRunLockDestructive` runs, outside the
    // `try` — and one thrown BY `fn` already has its remediation. A non-Error
    // throw gets no property (assignment on a primitive throws in strict
    // mode); its message is still what the caller prints.
    if (destructive && !completed && e instanceof Error && (e as { remediation?: unknown }).remediation === undefined) {
      (e as Error & { remediation: string }).remediation =
        `the destructive window for ${lock} was interrupted — the run lock was left in place on purpose; judge it (live holder? half-torn-down run?) and rm it before re-running any sweep`;
    }
    throw e;
  }
}

/**
 * Put a body this process took aside but does not own back at `lock`, and say
 * whether it landed. `link`, never `rename` — rename would overwrite a lock a
 * third invocation claimed at the path while this one was held aside.
 *
 * The taken copy is removed ONLY when the restore succeeded, or when the path
 * is provably occupied by someone else. An unproven body is never deleted: it
 * may be a live holder's claim, and nothing else in the system would put it back.
 *
 * Two errno classes are NOT "could not be put back":
 *
 *  - EEXIST means a third invocation already holds the path. Its lock is LIVE,
 *    and the generic remediation told the operator to `mv` this copy over it —
 *    the double teardown, printed as advice. The copy is worthless: discard it.
 *  - EPERM/ENOSYS/EOPNOTSUPP is the no-hard-link filesystem `claim` exists to
 *    support (exFAT, SMB, FUSE, some Docker bind mounts), where `linkSync`
 *    fails EVERY time. Without the same O_EXCL fallback `claim` has, the lock
 *    was gone — free for a concurrent invocation — while the holder's claim sat
 *    in a `.rescue` file `reapStaleTemps` deliberately does not sweep. That is
 *    the double teardown this module exists to prevent.
 */
function restore(claimed: string, lock: string): string {
  const discarded = `another invocation holds ${lock}, so the copy at ${claimed} was discarded rather than put back over a live lock`;
  const stranded = (why: string): string =>
    `it could not be put back (${why}) and is now at ${claimed} — mv it back to ${lock} once no other invocation holds it`;
  // This function is called INLINE inside a `throw new Error(\`… ${restore(…)}\`)`
  // template, so anything that escapes it replaces the diagnosis ("refusing to
  // release …", "it now holds …") with a bare fs errno — and the operator loses
  // both the reason and the `mv` remediation for a rescue file that may be the
  // only copy of a live holder's claim. `force: true` swallows ENOENT and
  // nothing else: EROFS, EIO and EACCES all still throw. Every cleanup below is
  // best-effort by construction — the claim's whereabouts, which is what the
  // returned sentence reports, does not depend on the tidy-up succeeding.
  const discard = (): void => {
    try {
      rmSync(claimed, { force: true });
    } catch {
      // Leftover rescue file: litter, not a correctness bug. The path either
      // holds a live lock (EEXIST) or the body we just put back.
    }
  };
  try {
    linkSync(claimed, lock);
    discard();
    return "it was put back";
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      discard();
      return discarded;
    }
    if (code !== "EPERM" && code !== "ENOSYS" && code !== "EOPNOTSUPP") return stranded(code ?? (e as Error).message);
  }
  try {
    if (!writeLockDirect(lock, readFileSync(claimed, "utf8"))) {
      discard();
      return discarded;
    }
    discard();
    return "it was put back";
  } catch (e) {
    return stranded((e as NodeJS.ErrnoException).code ?? (e as Error).message);
  }
}

/**
 * Release a lock acquired by THIS process, and only if it is still ours.
 *
 * An unconditional `rm` deletes whatever sits at the path — including a
 * different invocation's live lock, after ours was cleared by hand or reaped —
 * which is the exact double-teardown the lock exists to prevent. Releasing a
 * path this process never held is a no-op; finding a foreign body there throws,
 * because the caller's own exit code should say the run was left locked.
 *
 * Refuses outright while the lock is marked destructive and `force` is not set
 * — see `markRunLockDestructive` / `clearRunLockDestructive`.
 *
 * READ FIRST, then take. `rename` moves whatever the path points at, so taking
 * before comparing meant a lock that is no longer ours — cleared by hand,
 * reaped, then re-claimed by a live invocation — was moved out from under its
 * holder, leaving the path EMPTY for a third invocation to acquire while the
 * restore raced it; a failed restore then deleted the second holder's body for
 * good and both survivors believed they held the run. A body that is not ours
 * is now left exactly where it is, untouched.
 *
 * The read alone would still be a check-then-act (cleared and re-claimed
 * between the read and the unlink), so the unlink is a `rename` and the taken
 * bytes are compared again: the body proved below is provably the body removed.
 * That second comparison can only fail in the narrow window after our own bytes
 * were seen, and it restores rather than deletes.
 *
 * ponytail: no POSIX call unlinks a path conditionally on its inode, and
 * neither Node's nor Bun's `fs` exposes `flock(2)`/`fcntl` locks, so
 * read-verify-take-verify is the strongest release this runtime affords. If a
 * kernel-held lock ever becomes reachable (a native binding, or `fs` growing
 * one), that is the upgrade path — it would make the restore branch dead code.
 */
export function releaseRunLock(lock: string, opts: { force?: boolean } = {}): void {
  const body = moduleState().held.get(lock);
  if (body === undefined) return;
  // The destructive mark is NOT cleared by the act of releasing. "The caller
  // reached its `finally`" is what a deliberate release used to be inferred
  // from, and it looks identical whether the teardown returned or threw — so a
  // `fleet teardown` that destroyed the box and then failed released a clean
  // lock and handed the half-torn-down run to the next retry, which is the
  // state this module says only an operator can judge. The caller clears the
  // mark on its SUCCESS path (`clearRunLockDestructive`); `force` exists for a
  // caller that has judged the state itself and wants the lock gone anyway.
  if (moduleState().destructive.has(lock) && opts.force !== true) {
    throw new Error(
      `refusing to release ${lock}: this invocation was interrupted or failed after it began destroying the run, so the lock is deliberately left in place — check the run's box, key and record before anything else touches it, then rm ${lock} once you know the teardown state`,
    );
  }
  // The registration stays until a release SUCCEEDS (`held.delete` used to run
  // HERE, before any I/O — so the first EACCES/EIO/ESTALE left the lock on disk
  // with this process's body while every later release for it returned as a
  // silent no-op success and the exit handler skipped it too; an embedder whose
  // caller caught the throw and retried got a clean return with the run still
  // locked). Keeping it means a retry actually retries, `releaseHeldRunLocks`
  // still covers the path on the way out, and a proven-not-ours mismatch below
  // drops it — that lock is no longer ours to retry.
  // ENOENT deserves one exception: the lock is provably GONE, so "retrying"
  // could never do anything but report the same success. Drop the entry there,
  // exactly as before.

  let before: string;
  try {
    before = readFileSync(lock, "utf8");
  } catch (e) {
    // ENOENT: already gone (reaped, or cleared by hand and not yet re-taken) —
    // a no-op release. Any other errno means the body is UNKNOWN, and an
    // unknown body is precisely the one that must not be deleted.
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      moduleState().held.delete(lock);
      return;
    }
    throw e;
  }
  if (before !== body) {
    // Proven not ours — this process can never release it, so retrying on the
    // exit path is meaningless; drop the entry rather than leave a phantom.
    moduleState().held.delete(lock);
    throw new Error(
      `refusing to release ${lock}: it holds ${JSON.stringify(before.trim())}, not this invocation's claim — left untouched`,
    );
  }

  // `.rescue`, NOT the `.tmp` shape `reapStaleTemps` (and `RunRecordStore`'s own
  // `cleanStaleTemps`, which runs in this same directory on every CLI start)
  // sweep by dead pid. If `restore` below fails, this file is the ONLY copy of a
  // live holder's claim and the remediation tells the operator to `mv` it back —
  // but our pid is dead by then, so both reapers would garbage-collect it and a
  // new invocation would acquire freely: the double teardown, via the cleanup.
  // It only ever survives the failed-restore path; every other exit rms it.
  const claimed = `${lock}.${process.pid}.${randomBytes(4).toString("hex")}.rescue`;
  try {
    renameSync(lock, claimed);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      moduleState().held.delete(lock); // gone mid-release — the retry could never do more
      return;
    }
    throw e; // registration kept — dirty, retried by the caller or the exit handler
  }
  let onDisk: string;
  try {
    onDisk = readFileSync(claimed, "utf8");
  } catch (e) {
    throw new Error(`could not read ${lock} while releasing it (${(e as Error).message}) — ${restore(claimed, lock)}`);
  }
  if (onDisk === body) {
    // SUCCESS — drop the registration only now (see the comment at the top).
    moduleState().held.delete(lock);
    // The rename+verify above PROVED the taken bytes are ours — the release
    // has already succeeded, and this rm is tidy-up of our own private
    // `.rescue` copy. An unguarded rm here converted a SUCCESSFUL release into
    // a thrown "lock-release-failed" on EACCES/EIO: callers exited 1 over a
    // teardown that did land (after printing `torn down:`), the rescue copy
    // was left as litter anyway, and the remediation named an rm for a lock
    // that no longer existed. Best-effort, matching every other guarded
    // cleanup in this module; `force: true` already absorbs ENOENT.
    try {
      rmSync(claimed, { force: true });
    } catch (e) {
      writeStderr(
        `warning: released ${lock}, but could not remove the rescue copy ${claimed}: ${(e as Error).message}\n`,
      );
    }
    return;
  }
  // Re-claimed inside the rename window — vanishingly narrow, but the body is
  // someone else's and must go back rather than be deleted. Proven not ours
  // either way, so the entry is dropped (same reasoning as the pre-rename
  // mismatch); `restore` already put somebody else's claim back where it was.
  moduleState().held.delete(lock);
  throw new Error(
    `refusing to release ${lock}: it now holds ${JSON.stringify(onDisk.trim())}, not this invocation's claim — ${restore(claimed, lock)}`,
  );
}
