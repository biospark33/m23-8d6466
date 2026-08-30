/**
 * One O_EXCL advisory file lock (F062).
 *
 * Two independent implementations existed: the reverify approval lock, which
 * blocks and steals a stale lock with an ATOMIC rename-to-claim plus a content
 * re-verification, and the bank provisioner's, which never blocked and stole
 * with a plain `unlink` after a read — the read-then-delete race the approval
 * version's own comments explain is unsafe. Only one of the two was hardened,
 * so this is that one, with the differences the callers actually need
 * (blocking-or-not, and what counts as stale) as arguments.
 *
 * The lock file's content is `<pid>:<nonce>`. The pid lets a later waiter check
 * that the holder is really dead rather than merely slow; the nonce makes the
 * content unique per acquisition, so a reclaim cannot be fooled by a
 * replacement lock that happens to reuse the same pid.
 */
import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";

export interface StaleCheck {
  /** Age of the existing lock file by mtime. */
  ageMs: number;
  /** The holder's pid, or undefined when the content carries no usable one. */
  pid: number | undefined;
  /** The raw lock-file content, for a caller that writes more than `pid:nonce`. */
  raw: string;
}

export interface FileLockOptions {
  /**
   * May this existing lock be stolen? Called AFTER the content is read and
   * BEFORE the atomic claim — a `true` here only authorises the attempt; the
   * content re-verification below still decides whether the claim is kept.
   */
  isStale(check: StaleCheck): boolean;
  /** Names this lock in operator-facing messages. Default "file lock". */
  label?: string;
  /**
   * Poll until the lock is free. Omit for a non-blocking acquire, which
   * returns null the moment it finds a hold it may not take.
   */
  block?: {
    timeoutMs: number;
    /** Default 10 ms. */
    pollMs?: number;
    timeoutMessage?: (path: string, timeoutMs: number) => string;
  };
}

/**
 * Best-effort check that `pid` no longer refers to a live process. Signal 0
 * sends nothing but still validates the pid: ESRCH means the process is gone,
 * anything else (e.g. EPERM — alive but owned by another user) means we cannot
 * prove death and must NOT reclaim the lock.
 */
export function isPidDead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ESRCH";
  }
}

/** The pid half of a `<pid>:<nonce>` lock body, or undefined when unusable. */
export function lockHolderPid(raw: string): number | undefined {
  const pid = Number(raw.split(":", 1)[0]);
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

/** "the lock is free now" vs "someone else legitimately holds it". */
type StealResult = "freed" | "held";

/**
 * Take an existing lock away from a holder `isStale` accepts.
 *
 * `rename` is atomic on one filesystem, so at most one racer can move
 * `lockPath` onto its own private claim path — a second racer's rename fails
 * ENOENT instead of destroying what the first captured. The removal IS the
 * atomic step, so there is no read-then-delete gap for a replacement lock to
 * fall into.
 */
function trySteal(lockPath: string, isStale: FileLockOptions["isStale"], label: string): StealResult {
  // `claimed` tracks whether the rename below has already moved a file onto
  // this process's private claim path. Before that point a failure (the lock
  // vanishing between the stat and the read, say) is benign — nothing moved.
  // Once this process owns a file at the claim path it is holding either the
  // dead holder's lock or a live replacement's, and ANY failure past that
  // point must fail closed rather than be swallowed: swallowing it would free
  // `lockPath` for the next attempt while the claimed content sits stranded
  // off-path, letting two processes both believe they hold the lock.
  let claimed = false;
  try {
    const ageMs = Date.now() - statSync(lockPath).mtimeMs;
    const raw = readFileSync(lockPath, "utf8");
    if (!isStale({ ageMs, pid: lockHolderPid(raw), raw })) return "held";

    const claimPath = `${lockPath}.claim.${process.pid}.${randomUUID()}`;
    try {
      renameSync(lockPath, claimPath);
    } catch (renameErr) {
      if ((renameErr as NodeJS.ErrnoException).code === "ENOENT") return "freed"; // another racer claimed it first
      throw renameErr;
    }
    claimed = true;
    const content = readFileSync(claimPath, "utf8");
    if (content === raw) {
      rmSync(claimPath, { force: true }); // genuinely the dead holder's lock
      return "freed";
    }
    // A live replacement was captured by accident (created between the read
    // above and the rename). Put it back unless a new holder has since retaken
    // the path.
    try {
      writeFileSync(lockPath, content, { flag: "wx", mode: 0o600 });
    } catch (restoreErr) {
      if ((restoreErr as NodeJS.ErrnoException).code !== "EEXIST") {
        throw new Error(
          `${label} reclaim: failed to restore replacement lock from ${claimPath} back to ${lockPath}; remove or restore it by hand: ${(restoreErr as Error).message}`,
        );
      }
    }
    rmSync(claimPath, { force: true });
    return "held";
  } catch (err) {
    if (claimed) throw err; // own a claimed lock file — fail closed, never retry past it
    return "held"; // vanished between the open and the stat/read — the next attempt settles it
  }
}

/**
 * Release ONLY if the file still holds this acquisition's `pid:nonce`.
 *
 * `rmSync(path, { force: true })` unlinks whatever is there — and stealing on
 * age alone (bank-provisioner) means "whatever is there" can be ANOTHER
 * holder's lock: a long-running A that overran the staleness window gets
 * stolen by B, then A finishes and its release unlinks B's live lock. A gone
 * file is the already-released case and stays silent; a file with someone
 * else's content is left alone and surfaced, like trySteal's failed restore.
 */
function releaseOwn(path: string, content: string, label: string): void {
  let held: string;
  try {
    held = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return; // already gone
    throw e;
  }
  if (held !== content) {
    throw new Error(
      `${label} ${path} was taken over while held (expected ${content}, found ${held}); not releasing another holder's lock`,
    );
  }
  rmSync(path, { force: true });
}

/**
 * Acquire `path` exclusively. Returns a release function, or null when a
 * non-blocking acquire loses to a live holder. A blocking acquire never
 * returns null: it polls to its deadline and then throws.
 *
 * The deadline is checked AFTER a steal attempt, so a steal that succeeds on
 * the very last poll still throws rather than retaking the lock. Deadline
 * means deadline: a caller that has already waited its whole budget wants the
 * error, not a lock it will hold past the window it promised.
 */
export async function acquireFileLock(
  path: string,
  opts: FileLockOptions,
): Promise<(() => void) | null> { // dp:ok the acquire loop's try/catch sits inside `for (;;)`, which D017's frame walker attributes to the loop, not the function
  const label = opts.label ?? "file lock";
  const content = `${process.pid}:${randomUUID()}`;
  const deadline = opts.block ? Date.now() + opts.block.timeoutMs : 0;
  // A non-blocking caller gets exactly one steal attempt: after that, an
  // EEXIST is a hold it may not take, and looping would just spin.
  let stealsLeft = opts.block ? Number.POSITIVE_INFINITY : 1;

  for (;;) {
    try {
      writeFileSync(path, content, { flag: "wx", mode: 0o600 });
      return () => releaseOwn(path, content, label);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }

    let outcome: StealResult = "held";
    if (stealsLeft > 0) {
      stealsLeft -= 1;
      outcome = trySteal(path, opts.isStale, label);
    }
    if (!opts.block) {
      if (outcome === "held") return null;
      continue;
    }
    if (Date.now() >= deadline) {
      const message =
        opts.block.timeoutMessage?.(path, opts.block.timeoutMs) ??
        `${label} ${path} held for over ${opts.block.timeoutMs}ms; remove it by hand if nothing is running`;
      throw new Error(message);
    }
    if (outcome === "held") await Bun.sleep(opts.block.pollMs ?? 10);
  }
}
