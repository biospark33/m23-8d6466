/**
 * `src/lib/file-lock.ts` — the one O_EXCL lock (F062).
 *
 * Real files in a real tmpdir, and real concurrent acquirers. The property
 * under test is that a loser NEVER takes a lock a live holder still owns, and
 * that a steal is a rename-to-claim with content re-verification rather than a
 * read-then-delete.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { acquireFileLock, isPidDead, lockHolderPid } from "../../src/lib/file-lock.ts";

let dir: string;
let lockPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qds-file-lock-"));
  lockPath = join(dir, "x.lock");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Approval's policy: steal only a provably dead holder's aged-out lock. */
const deadHolderOnly = (staleMs: number) => (c: { ageMs: number; pid: number | undefined }) =>
  c.ageMs > staleMs && c.pid !== undefined && isPidDead(c.pid);

describe("acquireFileLock", () => {
  test("two blocking acquirers serialize; the loser does not steal a live lock", async () => {
    const order: string[] = [];
    const opts = { isStale: deadHolderOnly(10_000), block: { timeoutMs: 5_000, pollMs: 5 } };

    const first = await acquireFileLock(lockPath, opts);
    expect(first).not.toBeNull();
    const heldBy = readFileSync(lockPath, "utf8");
    order.push("A-acquired");

    let secondReleased = false;
    const second = acquireFileLock(lockPath, opts).then((release) => {
      order.push("B-acquired");
      expect(release).not.toBeNull();
      release?.();
      secondReleased = true;
    });

    // B must still be waiting, and A's content must be untouched — a poll that
    // stole a live lock would have overwritten it.
    await Bun.sleep(60);
    expect(order).toEqual(["A-acquired"]);
    expect(readFileSync(lockPath, "utf8")).toBe(heldBy);

    first?.();
    order.push("A-released");
    await second;
    expect(secondReleased).toBe(true);
    expect(order).toEqual(["A-acquired", "A-released", "B-acquired"]);
  });

  test("a blocking acquirer that never wins throws past its deadline", async () => {
    const release = await acquireFileLock(lockPath, { isStale: () => false, block: { timeoutMs: 5_000 } });
    expect(release).not.toBeNull();
    await expect(
      acquireFileLock(lockPath, {
        isStale: () => false,
        block: { timeoutMs: 40, pollMs: 5, timeoutMessage: (p, ms) => `lock ${p} held for over ${ms}ms` },
      }),
    ).rejects.toThrow(`lock ${lockPath} held for over 40ms`);
    release?.();
  });

  test("a stale lock is stolen by rename-to-claim, leaving no claim file behind", async () => {
    // PID 999999 is all but certainly not running; backdate the mtime too.
    writeFileSync(lockPath, "999999:abc");
    const old = new Date(Date.now() - 60_000);
    utimesSync(lockPath, old, old);

    const release = await acquireFileLock(lockPath, { isStale: deadHolderOnly(1_000) });
    expect(release).not.toBeNull();
    expect(lockHolderPid(readFileSync(lockPath, "utf8"))).toBe(process.pid);
    expect(Bun.spawnSync(["ls", dir]).stdout.toString().trim()).toBe("x.lock");
    release?.();
  });

  test("content re-verification puts back a live replacement captured by the claim", async () => {
    writeFileSync(lockPath, "999999:abc");
    const old = new Date(Date.now() - 60_000);
    utimesSync(lockPath, old, old);

    // `isStale` runs after the content is read and before the rename — the
    // exact window a replacement holder can land in.
    const replacement = `${process.pid}:live-replacement`;
    const release = await acquireFileLock(lockPath, {
      isStale: () => {
        writeFileSync(lockPath, replacement);
        return true;
      },
    });

    // The replacement is NOT ours to take: no lock granted, and its content is
    // restored rather than deleted (the read-then-delete race, closed).
    expect(release).toBeNull();
    expect(readFileSync(lockPath, "utf8")).toBe(replacement);
    expect(Bun.spawnSync(["ls", dir]).stdout.toString().trim()).toBe("x.lock");
  });

  test("non-blocking: a live fresh hold returns null instead of waiting", async () => {
    const release = await acquireFileLock(lockPath, { isStale: deadHolderOnly(10_000) });
    expect(release).not.toBeNull();
    expect(await acquireFileLock(lockPath, { isStale: deadHolderOnly(10_000) })).toBeNull();
    release?.();
    expect(await acquireFileLock(lockPath, { isStale: deadHolderOnly(10_000) })).not.toBeNull();
  });

  test("a non-EEXIST failure (unwritable path) escapes to the caller", async () => {
    writeFileSync(join(dir, "blocker"), "i am a file, not a dir");
    await expect(acquireFileLock(join(dir, "blocker", "x.lock"), { isStale: () => false })).rejects.toThrow();
  });

  test("lockHolderPid reads the pid half and rejects junk", () => {
    expect(lockHolderPid("123:abc")).toBe(123);
    expect(lockHolderPid("123")).toBe(123);
    expect(lockHolderPid("")).toBeUndefined();
    expect(lockHolderPid("nope")).toBeUndefined();
    expect(lockHolderPid("-1:x")).toBeUndefined();
  });
});
test("release does not unlink a lock another holder has since taken", async () => {
  const release = await acquireFileLock(lockPath, { isStale: () => true });
  expect(release).not.toBeNull();
  // A stole-on-age replacement: B now owns the path. A's release must not
  // unlink it — the failure mode is A overrunning the staleness window.
  writeFileSync(lockPath, "99999:b-nonce", { mode: 0o600 });
  expect(() => release?.()).toThrow(/taken over while held/);
  expect(readFileSync(lockPath, "utf8")).toBe("99999:b-nonce");
});

test("release is silent when the lock file is already gone", async () => {
  const release = await acquireFileLock(lockPath, { isStale: () => true });
  rmSync(lockPath, { force: true });
  expect(() => release?.()).not.toThrow();
});

