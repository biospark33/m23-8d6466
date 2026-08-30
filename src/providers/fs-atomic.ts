/**
 * The one copy of this slice's crash-safe filesystem primitives (F033).
 *
 * `fsyncDir`, `rmQuiet`, the mkdir-0700 → chmod → stat-verify block and
 * write-temp-then-rename each existed three or four times across
 * `src/fleet/fanout.ts`, `src/fleet/fleet-lock.ts` and
 * `src/providers/run-record.ts`. The copies had already drifted (see
 * `fsyncDir` below), which is the whole argument for one copy.
 *
 * fanout.ts's old comment argued `fsyncDir` must stay per-file so the lock
 * module is not coupled to the store module. That reasoning holds and this
 * module honours it: it is a LEAF — it imports node:fs and node:path and
 * nothing else, ever. Depending on it couples a caller to nothing.
 */

import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * fsync the DIRECTORY entry, best effort.
 *
 * `fsync` on a file's own fd persists its DATA, not the LINK — on ext4/xfs a
 * newly created file can be absent entirely after a power loss even though its
 * bytes were synced. Only a sync of the parent directory persists the name.
 *
 * Guarded end to end: a platform that cannot open or fsync a directory
 * (Windows, some FUSE and network mounts) must not fail a create over it. The
 * durability is best-effort; the create is not.
 */
export function fsyncDir(dir: string): void {
  let fd: number;
  try {
    fd = openSync(dir, "r");
  } catch {
    return;
  }
  try {
    fsyncSync(fd);
  } catch {
    // EINVAL/EPERM/ENOTSUP on a filesystem that does not sync directories.
  } finally {
    // Guarded like every other close: an EINTR-class close failure here used
    // to escape AFTER the record was durably written and synced, reporting the
    // create failed when it landed — and a caller-supplied-id retry then hit
    // EEXIST at a path holding a complete record. "Guarded end to end" has to
    // include this call or it is not.
    try {
      closeSync(fd);
    } catch {
      // close(2) consumes the descriptor whether it reports success or not;
      // nothing to do and nothing at risk.
    }
  }
}

/**
 * `rm -f` that cannot throw. Used where the removal is pure hygiene and the
 * caller is past the point where failing is safe — a leftover is pid-stamped,
 * so `cleanStaleTemps` really does sweep it once this process is gone.
 */
export function rmQuiet(p: string): void {
  try {
    rmSync(p, { force: true });
  } catch {
    // Nothing to do and nothing at risk: the file is inert and pid-stamped.
  }
}

/**
 * Create `dir` (recursively) at mode 0700 and PROVE it (INV-5).
 *
 * mkdir's mode is ignored when the directory already exists, and masked by
 * umask when it does not — so the mode is set explicitly, then verified.
 * `onBadMode` receives the observed mode as octal digits WITHOUT a leading
 * zero (e.g. `"755"`) and returns the error to throw, so each caller keeps its
 * own error type and message byte-for-byte.
 */
export function assertDirMode0700(dir: string, onBadMode: (octal: string) => Error): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const dirMode = statSync(dir).mode & 0o777;
  if (dirMode !== 0o700) throw onBadMode(dirMode.toString(8));
}

/**
 * Write-temp-then-rename. There is no in-place partial-write path (INV-3).
 *
 * The temp is `<target>.<pid>.<8 hex>.tmp` — the grammar run-record's
 * `cleanStaleTemps` and run-lock's `reapStaleTemps` admit, so a SIGKILL
 * between the write and the rename leaves something a later sweep can judge
 * and clear.
 *
 * `beforeRename` is run-record's crash-injection seam; it also observes the
 * temp path. A throw from it aborts before publishing, exactly as a failing
 * rename does.
 *
 * ponytail: the 8 hex digits come from Math.random, not `randomBytes` — this
 * module is a leaf and does not import node:crypto. Same 2^32 space as the
 * `randomBytes(4)` it replaces, and the temp is pid-stamped and opened with
 * O_EXCL, so a collision fails loudly rather than corrupting. Import
 * node:crypto here only if the leaf rule is ever relaxed.
 */
export function atomicReplaceFile(target: string, data: string, beforeRename?: (tmp: string) => void): void {
  const hex = Math.floor(Math.random() * 0x1_0000_0000)
    .toString(16)
    .padStart(8, "0");
  const tmp = `${target}.${process.pid}.${hex}.tmp`;
  const fd = openSync(tmp, "wx", 0o600);
  let fdOpen = true;
  try {
    writeFileSync(fd, data);
    // The RECORD is the durable artifact — a truncated one makes its reader
    // throw for that id forever. The ephemeral lock was fsynced and this was
    // not: exactly inverted.
    fsyncSync(fd);
    // Cleared BEFORE the call: a throwing close still consumes the descriptor,
    // so the catch must not close it again.
    fdOpen = false;
    closeSync(fd);
    beforeRename?.(tmp);
    renameSync(tmp, target);
    // F033 behaviour change: run-record's copy fsynced the FILE but not the
    // directory entry, so a power loss in this window lost the rename (the
    // record reverted to its prior complete contents — never truncated, but a
    // mutation reported committed could vanish). fanout's copy already synced
    // here; one copy means one answer, and this is the strict one.
    fsyncDir(dirname(target));
  } catch (e) {
    // Guarded, not try/catch'd: fd numbers are recycled, and `beforeRename`
    // may have opened something else by the time we land here.
    // The close itself is ALSO guarded: close(2) can report a deferred
    // writeback error (e.g. EIO on Linux/NFS after a failed write or fsync),
    // and that must not replace the real error `e` nor skip the cleanup below.
    if (fdOpen) {
      try {
        closeSync(fd);
      } catch {
        // close(2) consumes the descriptor either way.
      }
    }
    // Quiet, same doctrine as the lock cleanups: this temp is inert litter if
    // it survives, and a throwing rm here would replace the REAL error `e`.
    rmQuiet(tmp);
    throw e;
  }
}
