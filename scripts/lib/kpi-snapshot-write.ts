/**
 * A5 leaf — the snapshot write leg (typed script errors + the append-only
 * snapshot claim), split out of scripts/qds-kpi.ts for the <500-line file rule
 * (same precedent as kpi-retain.ts). Behavior contract lives in that script's
 * docblock; the load-bearing facts are restated on writeSnapshot below.
 */
import { closeSync, fsyncSync, linkSync, mkdirSync, openSync, statSync, unlinkSync, writeSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { stableStringify, type KpiSnapshotPayload } from "../../src/kpi/kpis.ts";

/** Typed script failure: code + remediation ride the `!!` envelope, exit != 0. */
export class KpiScriptError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly remediation: string,
  ) {
    super(message);
    this.name = "KpiScriptError";
  }
}

/**
 * Append-only snapshot write (F-001 temp discipline + R2-02 atomicity): bytes
 * land in a unique temp file (wx 0600) in the snapshots dir, are fsynced, and
 * only then ATOMICALLY CLAIM the immutable ms-stamped FINAL name via link(2) —
 * link is an exclusive create, so a same-ms collision with a concurrent
 * invocation refuses fail-loud (kpi-snapshot-exists, AC5 — a prior snapshot is
 * never overwritten or mutated; POSIX rename would have silently replaced it).
 * The claim leaves the temp name behind — unlinked immediately after; a crash
 * or ENOSPC mid-write strands only the temp, unlinked best-effort on every
 * pre-claim failure, so no truncated file ever persists under the final name.
 * The write loop carries the 0-return guard (a writeSync accepting 0 bytes
 * would spin forever). R2-10: a PRE-EXISTING snapshots dir with a mode wider
 * than 0700 refuses typed — 0600 spend snapshots must not sit in a
 * world-readable directory (mirrors RunRecordStore's assertDirMode0700,
 * src/providers/run-record.ts:1291; mkdirSync never re-permissions an
 * existing dir).
 */
export function writeSnapshot(snapshotsDir: string, payload: KpiSnapshotPayload, now: Date): string {
  mkdirSync(snapshotsDir, { recursive: true, mode: 0o700 });
  const dirMode = statSync(snapshotsDir).mode & 0o777;
  if (dirMode !== 0o700) {
    throw new KpiScriptError(
      "kpi-snapshot-dir-mode",
      `snapshots dir ${snapshotsDir} is mode 0${dirMode.toString(8)}, not 0700`,
      "chmod 0700 the snapshots dir and re-run — spend snapshots are 0600 and must not land in a wider-mode directory",
    );
  }
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const finalPath = join(snapshotsDir, `${stamp}.json`);
  const tempPath = join(snapshotsDir, `.${stamp}.tmp-${process.pid}-${randomUUID()}`);
  const bytes = Buffer.from(stableStringify(payload), "utf8");
  let fd: number | undefined;
  try {
    fd = openSync(tempPath, "wx", 0o600);
    let off = 0;
    while (off < bytes.length) {
      const n = writeSync(fd, bytes, off, bytes.length - off);
      if (n <= 0) {
        throw new KpiScriptError(
          "kpi-snapshot-write-failed",
          `snapshot temp write accepted 0 of ${bytes.length - off} bytes`,
          "re-run — the temp file is removed and the final name was never touched",
        );
      }
      off += n;
    }
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    try {
      linkSync(tempPath, finalPath);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") {
        throw new KpiScriptError(
          "kpi-snapshot-exists",
          `snapshot ${finalPath} already exists — same-millisecond filename collision; a prior snapshot is never overwritten or mutated (AC5)`,
          "re-run — the next millisecond mints a fresh filename; prior snapshots are immutable",
        );
      }
      throw e; // any other link error → the outer wrap's typed kpi-snapshot-write-failed
    }
    unlinkSync(tempPath); // the claim leaves the temp name behind — clean it
  } catch (e) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // already closed — nothing to leak
      }
    }
    try {
      unlinkSync(tempPath);
    } catch {
      // best-effort: the temp name is unique per attempt, never the final name
    }
    if (e instanceof KpiScriptError) throw e;
    const code = (e as NodeJS.ErrnoException).code;
    throw new KpiScriptError("kpi-snapshot-write-failed", `cannot write snapshot ${finalPath} (${code ?? (e as Error).message})`, "check the snapshots directory's permissions and re-run");
  }
  // Best-effort directory sync (run-record's fsyncDir posture): a platform that
  // refuses it must not fail a durable-enough file.
  try {
    const dirFd = openSync(snapshotsDir, "r");
    fsyncSync(dirFd);
    closeSync(dirFd);
  } catch {
    // Hygiene only.
  }
  return finalPath;
}
