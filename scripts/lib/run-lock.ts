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
 * table, and a shared runs directory (an NFS mount, a bind-mounted volume, a CI
 * runner and a laptop) makes that answer about a stranger. Bodies written
 * before the field existed are `<pid> <ISO> <nonce>` and still parse — the
 * field that looks like an ISO timestamp tells the two layouts apart.
 */

import { randomBytes } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  linkSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

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
  constructor(lockPath: string, who: string, holder = "invocation", stale = false, note = "") {
    super(`another ${holder} holds ${lockPath} (${who})`);
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
 * Locks THIS process created and has not released yet: path → the exact body
 * written into it. Release compares the body back before unlinking, so a lock
 * re-created by a different invocation (ours crashed, theirs claimed the path)
 * is never deleted out from under its live holder.
 */
const held = new Map<string, string>();

/** This host's name, with whitespace folded — the body is whitespace-delimited. */
function lockHost(): string {
  return hostname().replace(/\s+/g, "_") || "unknown-host";
}

/**
 * Same probe `RunRecordStore` uses for its stale temps (run-record.ts's
 * `isAlive`): signal 0 tests existence, EPERM means alive but not ours.
 * Duplicated rather than imported because that copy is module-private.
 *
 * Host-local by construction — only ever called for a body this host wrote.
 */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Best-effort durability for the directory entry the link created. */
function fsyncDir(dir: string): void {
  let dfd: number | undefined;
  try {
    dfd = openSync(dir, "r");
    fsyncSync(dfd);
  } catch {
    // Not every platform/filesystem permits fsync on a directory handle; the
    // link itself is the mutual-exclusion boundary, the fsync only its durability.
  } finally {
    if (dfd !== undefined) closeSync(dfd);
  }
}

let signalsInstalled = false;

/**
 * One Ctrl-C during teardown used to leave the lock on disk forever: every
 * later harvest/teardown of that run refused while the box and the API key
 * stayed live and billing. Release on the way out, then re-raise the signal so
 * the process still dies of what killed it (exit status 128+n, not 0).
 *
 * `process.once` makes this idempotent — the handler is gone before the
 * re-raise, so the second delivery takes the default action.
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
  if (signalsInstalled) return;
  signalsInstalled = true;
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"] as const) {
    process.once(sig, () => {
      releaseHeldRunLocks();
      process.kill(process.pid, sig);
    });
  }
  // Sync by construction (`releaseHeldRunLocks` is all *Sync calls) — an async
  // release here would never run. Releasing an empty `held` is a no-op, so this
  // costs nothing on the normal path where the caller's finally already released.
  process.on("exit", releaseHeldRunLocks);
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

/** Release every lock this process still holds, reporting failures to stderr. */
export function releaseHeldRunLocks(): void {
  for (const lock of [...held.keys()]) {
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
 * Describe the invocation currently holding `lock` for the refusal message, or
 * `undefined` when the lock VANISHED between the caller's EEXIST and this read
 * — a free run, not an unreadable one, so the caller retries rather than
 * printing an `rm` for a path that no longer exists.
 */
function refuse(lock: string, holder: string): RunLockedError | undefined {
  let body = "";
  try {
    body = readFileSync(lock, "utf8").trim();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    // present but unreadable — fail closed below with what we do know
  }
  const { pid, host, at } = parseLockBody(body);
  if (!/^\d+$/.test(pid ?? "") || Number.isNaN(at)) {
    return new RunLockedError(lock, `holder unknown, lock body ${JSON.stringify(body)}`, holder);
  }
  const age = Math.max(0, Math.round((Date.now() - at) / 1000));
  // A pid is only meaningful on the host that minted it. Probing our own
  // process table for a foreign host's pid returns either a false "not running"
  // — and the remediation then tells the operator to rm a LIVE holder's lock,
  // re-opening the double teardown — or a false "alive" via pid reuse. Say
  // "unknown" instead, and never mark a foreign lock stale.
  if (host !== undefined && host !== lockHost()) {
    return new RunLockedError(lock, `pid ${pid} on host ${host}, liveness unknown from here, held ${age}s`, holder);
  }
  // PID liveness, not just the number: without it the printed remediation
  // ("only if that pid is gone") is unfollowable, and pid reuse makes it wrong.
  const alive = isAlive(Number(pid));
  const who = `pid ${pid}${alive ? "" : " is not running"}, held ${age}s`;
  // Pid reuse cuts BOTH ways, and this is the direction the comment above does
  // not cover: after a SIGKILL the OS can recycle the holder's pid onto an
  // unrelated process, `isAlive` reads that stranger as the holder, and the
  // remediation then tells the operator to wait on a process that will never
  // release. No steal and no TTL — this module's no-steal property is
  // load-bearing, and a timeout would resurrect the double teardown it exists
  // to prevent. Make the DIAGNOSIS honest instead: the body already carries
  // `createdAt`, so an implausible hold is detectable, and a process start time
  // later than the lock's proves the pid is not the holder.
  const note =
    alive && age > IMPLAUSIBLE_HOLD_S
      ? ` — note: held ${age}s, far longer than any invocation runs. If its holder was SIGKILLed the OS may have recycled pid ${pid} onto an unrelated process: check \`ps -p ${pid} -o lstart=,args=\`, and if that process started after ${new Date(at).toISOString()} it is NOT the holder and the lock is safe to rm`
      : "";
  return new RunLockedError(lock, who, holder, !alive, note);
}

/**
 * Reap `<runId>.lock.<pid>.<hex>.tmp` left by a process that died between the
 * temp's creation and its unlink (SIGKILL, ENOSPC, power loss). Nothing else
 * removes them and they accumulate in the same directory the record/bundle
 * listings glob over. Only temps whose recorded pid is gone are removed — a
 * live pid's temp is mid-acquire.
 *
 * `.tmp` ONLY, deliberately: a `claim` temp is a copy of our own body and is
 * pure litter once we are gone, whereas `releaseRunLock`'s `.rescue` file is
 * the last copy of somebody else's live claim and an operator is told to `mv`
 * it back. The two must not share a filename shape.
 */
function reapStaleTemps(runsDir: string, runId: string): void {
  const prefix = `${runId}.lock.`;
  let names: string[];
  try {
    names = readdirSync(runsDir);
  } catch {
    return; // the acquire below reports a missing/unreadable directory properly
  }
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith(".tmp")) continue;
    const pid = Number(name.slice(prefix.length).split(".")[0]);
    if (!Number.isInteger(pid) || pid <= 0 || isAlive(pid)) continue;
    try {
      rmSync(join(runsDir, name), { force: true });
    } catch {
      // Best effort: a temp we cannot remove is litter, never a correctness bug.
    }
  }
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
function claim(lock: string, body: string): boolean {
  const tmp = `${lock}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
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
      if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
      return writeLockDirect(lock, body);
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
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
function writeLockDirect(lock: string, body: string): boolean {
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
 */
export function acquireRunLock(runsDir: string, runId: string, holder = "invocation"): string {
  // The id is joined into a filesystem path: validate BEFORE the join, on the
  // same grammar the record store enforces, not after the path exists.
  assertValidRunId(runId);
  // FIRST, before a lock can exist: a SIGINT (or a throw) after the link but
  // before the handler was registered left `<runId>.lock` on disk with nothing
  // to release it, and this module never steals — every later harvest/teardown
  // of that run refused forever while the box and the key stayed live and
  // billing. Releasing an empty `held` is a no-op, so installing early is free.
  installSignalRelease();
  const lock = join(runsDir, `${runId}.lock`);
  if (held.has(lock)) throw new RunLockReentrantError(lock);
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
      held.set(lock, body);
      fsyncDir(runsDir);
      return lock;
    }
    const refusal = refuse(lock, holder);
    if (refusal !== undefined) throw refusal;
  }
  throw new RunLockedError(lock, "the lock is being taken and released repeatedly", holder);
}

/**
 * Put a body this process took aside but does not own back at `lock`, and say
 * whether it landed. `link`, never `rename` — rename would overwrite a lock a
 * third invocation claimed at the path while this one was held aside.
 *
 * The taken copy is removed ONLY when the restore succeeded. An unproven body
 * is never deleted: it may be a live holder's claim, and nothing else in the
 * system would put it back.
 */
function restore(claimed: string, lock: string): string {
  try {
    linkSync(claimed, lock);
  } catch (e) {
    const why = (e as NodeJS.ErrnoException).code ?? (e as Error).message;
    return `it could not be put back (${why}) and is now at ${claimed} — mv it back to ${lock} once no other invocation holds it`;
  }
  rmSync(claimed, { force: true });
  return "it was put back";
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
export function releaseRunLock(lock: string): void {
  const body = held.get(lock);
  if (body === undefined) return;
  // Dropped first: a failed release must not be retried by the signal handler.
  held.delete(lock);

  let before: string;
  try {
    before = readFileSync(lock, "utf8");
  } catch (e) {
    // ENOENT: already gone (reaped, or cleared by hand and not yet re-taken) —
    // a no-op release. Any other errno means the body is UNKNOWN, and an
    // unknown body is precisely the one that must not be deleted.
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    throw e;
  }
  if (before !== body) {
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
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    throw e;
  }
  let onDisk: string;
  try {
    onDisk = readFileSync(claimed, "utf8");
  } catch (e) {
    throw new Error(`could not read ${lock} while releasing it (${(e as Error).message}) — ${restore(claimed, lock)}`);
  }
  if (onDisk === body) {
    rmSync(claimed, { force: true });
    return;
  }
  // Re-claimed inside the rename window — vanishingly narrow, but the body is
  // someone else's and must go back rather than be deleted.
  throw new Error(
    `refusing to release ${lock}: it now holds ${JSON.stringify(onDisk.trim())}, not this invocation's claim — ${restore(claimed, lock)}`,
  );
}
