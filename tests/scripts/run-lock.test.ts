/**
 * scripts/lib/run-lock.ts — the acquisition wrapper (`withRunLock`) and the
 * `RunLockHandle` brand (DF2.11 AC1).
 *
 * What lives here is the wrapper's release posture — success, non-destructive
 * throw, destructive throw — the mark-before-`fn` ordering, and the
 * cross-process refusal a second invocation must get while a first one holds
 * `<runId>.lock` (real contention via `Bun.spawn`, not a stubbed `claim`).
 *
 * The module parks its `held`/`destructive` state on `globalThis` and registers
 * its signal handler on first acquire, so every test acquires into its OWN
 * mkdtemp'd directory (no two tests share a lock path) and releases what it
 * acquires; the destructive-throw test performs the operator-judged
 * `clearRunLockDestructive` + release in a `finally` so neither the mark nor
 * the `held` entry leaks into a later test in this process.
 */

import { describe, expect, test, afterEach, beforeEach } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  acquireRunLock,
  clearRunLockDestructive,
  markRunLockDestructive,
  releaseHeldRunLocks,
  releaseRunLock,
  RunLockedError,
  withRunLock,
} from "../../scripts/lib/run-lock.ts";
import type { RunLockHandle } from "../../scripts/lib/run-lock.ts";

/** Absolute module path handed to the spawned holder process. */
const MODULE_PATH = fileURLToPath(new URL("../../scripts/lib/run-lock.ts", import.meta.url));

const RUN_ID = "test-20260908-aaaa01"; // `<slug>-<YYYYMMDD>-<hex>` — assertValidRunId's grammar

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qds-run-lock-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** The resolved lock path — `acquireRunLock` resolves, `join` of a clean absolute dir is the same string. */
const lockPath = (): string => join(dir, `${RUN_ID}.lock`);

describe("run-lock: withRunLock + RunLockHandle", () => {
  test("passes the acquired handle to fn and releases after it resolves", async () => {
    // Typed `string | undefined` on purpose: the assignment IS the widening
    // proof — a RunLockHandle lands in a plain-string slot with no cast.
    let seen: string | undefined;
    const result = await withRunLock(dir, RUN_ID, "test", async (handle) => {
      seen = handle;
      expect(existsSync(lockPath())).toBeTrue();
      return 42;
    });

    expect(result).toBe(42);
    expect(seen).toBe(lockPath());
    // Released: the file is gone, and the path acquires again immediately —
    // which also proves the `held` entry (the reentrancy guard) was dropped.
    expect(existsSync(lockPath())).toBeFalse();
    releaseRunLock(acquireRunLock(dir, RUN_ID, "test"));
    expect(existsSync(lockPath())).toBeFalse();
  });

  test("releases after fn throws (non-destructive)", async () => {
    await expect(
      withRunLock(dir, RUN_ID, "test", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    // Nothing was mutated, so the release is the ordinary one.
    expect(existsSync(lockPath())).toBeFalse();
    const h = acquireRunLock(dir, RUN_ID, "test");
    releaseRunLock(h);
    expect(existsSync(lockPath())).toBeFalse();
  });

  test("destructive: marks BEFORE fn, then clears and releases on success", async () => {
    await withRunLock(
      dir,
      RUN_ID,
      "test",
      async (handle) => {
        // The mark is in place before fn runs: a release at this point is
        // refused (the throw happens before any mutation, so the probe is safe).
        expect(() => releaseRunLock(handle)).toThrow(/refusing to release/);
        return "ok";
      },
      { destructive: true },
    );

    expect(existsSync(lockPath())).toBeFalse();
    // The mark was CLEARED, not left behind: a fresh acquire releases without
    // the refusal a stale destructive mark would raise.
    const h = acquireRunLock(dir, RUN_ID, "test");
    expect(() => releaseRunLock(h)).not.toThrow();
    expect(existsSync(lockPath())).toBeFalse();
  });

  test("destructive + fn throw: lock file AND mark survive; releaseHeldRunLocks refuses", async () => {
    try {
      await expect(
        withRunLock(
          dir,
          RUN_ID,
          "test",
          async () => {
            throw new Error("destroyed mid-flight");
          },
          { destructive: true },
        ),
      ).rejects.toThrow("destroyed mid-flight");

      // The fn error is the one that propagated — the refused release was
      // never attempted, so it could not mask the failure.
      expect(existsSync(lockPath())).toBeTrue();
      // The exit path's refusal: the operator line goes to stderr and the file
      // stays exactly where it is.
      releaseHeldRunLocks();
      expect(existsSync(lockPath())).toBeTrue();
      // Still marked: the release primitives stay refused until the state is
      // judged (the cleanup below IS that judgment, as a CLI's would be).
      expect(() => releaseRunLock(lockPath())).toThrow(/refusing to release/);
    } finally {
      // Operator-judged clear + release, so the mark and the `held` entry do
      // not leak into the next test in this process. Both are safe no-ops if
      // the assertions above never got the lock acquired.
      clearRunLockDestructive(lockPath());
      releaseRunLock(lockPath());
    }
  });

  test(
    "refuses while ANOTHER PROCESS holds the lock (RunLockedError, code, remediation)",
    async () => {
      // The child takes the lock itself through this same module, proves it by
      // writing a sentinel, then holds for a minute (the test kills it).
      const childCode = [
        "const { acquireRunLock } = await import(process.env.RUN_LOCK_MODULE);",
        "const { writeFileSync } = await import(\"node:fs\");",
        "acquireRunLock(process.env.RUN_LOCK_DIR, process.env.RUN_LOCK_ID, \"other-invocation\");",
        "writeFileSync(process.env.RUN_LOCK_SENTINEL, \"held\");",
        "await new Promise((resolve) => setTimeout(resolve, 60_000));",
      ].join("\n");
      const sentinel = join(dir, "held.sentinel");
      const child = Bun.spawn(["bun", "-e", childCode], {
        env: {
          ...process.env,
          RUN_LOCK_MODULE: MODULE_PATH,
          RUN_LOCK_DIR: dir,
          RUN_LOCK_ID: RUN_ID,
          RUN_LOCK_SENTINEL: sentinel,
        },
        stdout: "pipe",
        stderr: "pipe",
      });

      try {
        // Never assert against an un-held lock: that refusal would pass for the
        // wrong reason. Wait until the child PROVES it holds the path.
        const deadline = Date.now() + 20_000;
        while (!existsSync(sentinel)) {
          if (Date.now() > deadline) {
            child.kill();
            await child.exited;
            const stderr = await new Response(child.stderr).text();
            throw new Error(`the holder process never took the lock: ${stderr}`);
          }
          await new Promise((resolve) => setTimeout(resolve, 25));
        }

        let err: unknown;
        try {
          await withRunLock(dir, RUN_ID, "test", async () => "unreachable");
        } catch (e) {
          err = e;
        }
        expect(err).toBeInstanceOf(RunLockedError);
        const refusal = err as RunLockedError;
        expect(refusal.code).toBe("run-locked");
        expect(refusal.message).toContain(lockPath());
        expect(refusal.remediation.length).toBeGreaterThan(0);
      } finally {
        child.kill();
        await child.exited;
      }
    },
    // bun's default per-test timeout is 5s; the child's `bun` startup plus the
    // sentinel poll need room.
    { timeout: 30_000 },
  );

  test("acquireRunLock's return feeds the mark/clear/release primitives (round trip)", () => {
    const handle = acquireRunLock(dir, RUN_ID, "test");
    // Compile-time widening: RunLockHandle IS a string, so the primitives'
    // `string` parameters accept it without a cast at the call site.
    const widened: string = handle;
    expect(widened).toBe(lockPath());

    markRunLockDestructive(handle);
    expect(() => releaseRunLock(handle)).toThrow(/refusing to release/);
    clearRunLockDestructive(handle);
    releaseRunLock(handle);
    expect(existsSync(lockPath())).toBeFalse();
  });

  test("a bare string is not a RunLockHandle (the brand cannot be forged)", () => {
    // @ts-expect-error — the brand's whole point: no string literal or resolve()
    // output satisfies RunLockHandle, and there is no exported cast helper. bun
    // strips types without checking, so `tsc --noEmit` is the gate that fails
    // if the brand is ever loosened.
    const forged: RunLockHandle = lockPath();
    // Compared string-actual-side: bun's `toBe` is invariant on the actual's
    // type, and a handle on the EXPECTED side is just a string subtype.
    expect(lockPath()).toBe(forged);
  });
});
