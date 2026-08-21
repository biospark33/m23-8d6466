/**
 * The per-run invocation lock (DF2.5) — shared by every CLI that can harvest
 * or tear a run down (`scripts/sandbox-teardown.ts`, `scripts/fleet.ts`).
 *
 * One invocation per run at a time: `<runsDir>/<runId>.lock` serializes
 * concurrent CLI calls; a stale lock is reported (never stolen) with the
 * holder's pid and the exact `rm` that clears it. This is a concurrency guard
 * for destructive verbs, so the two entry points share ONE implementation —
 * a fix here must not fork per CLI.
 */

import { closeSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * `<runId>.lock` is already held by another invocation. Carries the
 * code/remediation shape the CLIs' catch blocks map onto their error output —
 * thrown between the record read and any mutation, so a refused invocation
 * touches nothing.
 */
export class RunLockedError extends Error {
  readonly code = "run-locked";
  readonly remediation: string;
  constructor(lockPath: string, who: string) {
    super(`another invocation holds ${lockPath} (${who})`);
    this.remediation = `wait for that invocation to finish — or, only if ${who} is gone: rm ${lockPath}`;
  }
}

/**
 * Claim `<runsDir>/<runId>.lock` (O_EXCL) for the duration of one invocation,
 * writing `<pid> <createdAt-ISO>` so a refused invocation can name the holder.
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
export function acquireRunLock(runsDir: string, runId: string): string {
  const lock = join(runsDir, `${runId}.lock`);
  let fd: number | undefined;
  let created = false;
  try {
    fd = openSync(lock, "wx", 0o600);
    created = true;
    writeFileSync(fd, `${process.pid} ${new Date().toISOString()}\n`);
    closeSync(fd);
    fd = undefined;
    return lock;
  } catch (e) {
    // A failure AFTER our own O_EXCL create (ENOSPC/EIO on the write, a failed
    // close) must not wedge the lock on disk for every later invocation: close
    // the fd and remove exactly the file THIS invocation created, then rethrow
    // the original error. EEXIST never arrives with created=true — the other
    // holder's lock stays untouched.
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // the close itself failed; nothing further to release
      }
    }
    if (created) {
      try {
        rmSync(lock, { force: true });
      } catch (cleanup) {
        // The acquisition error is the story: report the cleanup failure as
        // its OWN stderr diagnostic and rethrow the original regardless. A
        // wedged lock resurfaces on the next invocation's run-locked refusal.
        console.error(
          `!! lock-cleanup-failed: could not remove ${lock} after failed acquisition: ${(cleanup as Error).message}\nnext: rm ${lock} once the acquisition failure is understood`,
        );
      }
    }
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    let held = "";
    try {
      held = readFileSync(lock, "utf8").trim();
    } catch {
      // present but unreadable — fail closed below with what we do know
    }
    const [pid, iso] = held.split(/\s+/);
    const at = Date.parse(iso ?? "");
    const who =
      /^\d+$/.test(pid ?? "") && !Number.isNaN(at)
        ? `pid ${pid}, held ${Math.max(0, Math.round((Date.now() - at) / 1000))}s`
        : `holder unknown, lock body ${JSON.stringify(held)}`;
    throw new RunLockedError(lock, who);
  }
}
