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
 */

import { randomBytes } from "node:crypto";
import { closeSync, fsyncSync, linkSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  constructor(lockPath: string, who: string, holder = "invocation", stale = false) {
    super(`another ${holder} holds ${lockPath} (${who})`);
    this.remediation = stale
      ? `no live process holds it (${who}) — rm ${lockPath} to clear the stale lock, then re-run`
      : `wait for that invocation to finish — or, only if ${who} is gone: rm ${lockPath}`;
  }
}

/**
 * Locks THIS process created and has not released yet: path → the exact body
 * written into it. Release compares the body back before unlinking, so a lock
 * re-created by a different invocation (ours crashed, theirs claimed the path)
 * is never deleted out from under its live holder.
 */
const held = new Map<string, string>();

/**
 * Same probe `RunRecordStore` uses for its stale temps (run-record.ts's
 * `isAlive`): signal 0 tests existence, EPERM means alive but not ours.
 * Duplicated rather than imported because that copy is module-private.
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
 */
function installSignalRelease(): void {
  if (signalsInstalled) return;
  signalsInstalled = true;
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.once(sig, () => {
      releaseHeldRunLocks();
      process.kill(process.pid, sig);
    });
  }
}

/** Release every lock this process still holds, reporting failures to stderr. */
export function releaseHeldRunLocks(): void {
  for (const lock of [...held.keys()]) {
    try {
      releaseRunLock(lock);
    } catch (e) {
      console.error(
        `!! lock-release-failed: could not release ${lock}: ${(e as Error).message}\nnext: rm ${lock} by hand once no other invocation holds it — until then every later teardown of this run refuses`,
      );
    }
  }
}

/** Describe the invocation currently holding `lock` for the refusal message. */
function refuse(lock: string, holder: string): RunLockedError {
  let body = "";
  try {
    body = readFileSync(lock, "utf8").trim();
  } catch {
    // present but unreadable — fail closed below with what we do know
  }
  const [pid, iso] = body.split(/\s+/);
  const at = Date.parse(iso ?? "");
  if (!/^\d+$/.test(pid ?? "") || Number.isNaN(at)) {
    return new RunLockedError(lock, `holder unknown, lock body ${JSON.stringify(body)}`, holder);
  }
  // PID liveness, not just the number: without it the printed remediation
  // ("only if that pid is gone") is unfollowable, and pid reuse makes it wrong.
  const alive = isAlive(Number(pid));
  const age = Math.max(0, Math.round((Date.now() - at) / 1000));
  const who = `pid ${pid}${alive ? "" : " is not running"}, held ${age}s`;
  return new RunLockedError(lock, who, holder, !alive);
}

/**
 * Claim `<runsDir>/<runId>.lock` for the duration of one invocation, writing
 * `<pid> <createdAt-ISO> <nonce>` so a refused invocation can name the holder
 * and so `releaseRunLock` can prove the lock it unlinks is still ours.
 *
 * Two concurrent invocations for the same run both pass the closedAt gate
 * inside harvest/teardown (a check-then-act) and then double-revoke,
 * double-destroy and interleave writes to the fixed `<runId>.bundle` /
 * `<runId>-artifacts` paths. Unlike the store's per-write lock, this one never
 * steals: a stale lock means an uncertain teardown state, which is exactly the
 * moment an operator — not a heuristic — should decide.
 *
 * Written into a temp file and `link(2)`ed into place rather than created with
 * O_EXCL and written after: link is equally exclusive and equally atomic, but
 * the file is already complete and fsynced when it appears, so a concurrent
 * reader can never observe an empty body and report "holder unknown".
 *
 * ponytail: library callers bypass the lock — the CLIs are the operator surface.
 */
export function acquireRunLock(runsDir: string, runId: string, holder = "invocation"): string {
  // The id is joined into a filesystem path: validate BEFORE the join, on the
  // same grammar the record store enforces, not after the path exists.
  assertValidRunId(runId);
  const lock = join(runsDir, `${runId}.lock`);
  const body = `${process.pid} ${new Date().toISOString()} ${randomBytes(4).toString("hex")}\n`;
  const tmp = `${lock}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  const fd = openSync(tmp, "wx", 0o600);
  let fdOpen = true;
  try {
    writeFileSync(fd, body);
    fsyncSync(fd);
    closeSync(fd);
    fdOpen = false;
    linkSync(tmp, lock);
  } catch (e) {
    // Guarded, not try/catch'd (the store's atomicReplace idiom): once
    // closeSync has thrown the fd is gone, and fd numbers are recycled — a
    // second close could land on a stranger's handle.
    if (fdOpen) closeSync(fd);
    rmSync(tmp, { force: true });
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    throw refuse(lock, holder);
  }
  rmSync(tmp, { force: true });
  fsyncDir(runsDir);
  held.set(lock, body);
  installSignalRelease();
  return lock;
}

/**
 * Release a lock acquired by THIS process, and only if it is still ours.
 *
 * An unconditional `rm` deletes whatever sits at the path — including a
 * different invocation's live lock, after ours was cleared by hand or reaped —
 * which is the exact double-teardown the lock exists to prevent. Releasing a
 * path this process never held is a no-op; finding a foreign body there throws,
 * because the caller's own exit code should say the run was left locked.
 */
export function releaseRunLock(lock: string): void {
  const body = held.get(lock);
  if (body === undefined) return;
  // Dropped first: a failed release must not be retried by the signal handler.
  held.delete(lock);
  let onDisk: string;
  try {
    onDisk = readFileSync(lock, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    throw e;
  }
  if (onDisk !== body) {
    throw new Error(
      `refusing to release ${lock}: it now holds ${JSON.stringify(onDisk.trim())}, not this invocation's claim`,
    );
  }
  rmSync(lock, { force: true });
}
