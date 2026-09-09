/**
 * scripts/lib/run-lock.ts — the acquisition wrapper (`withRunLock`) and the
 * `RunLockHandle` brand (DF2.11 AC1).
 *
 * What lives here is the wrapper's release posture — success, non-destructive
 * throw, destructive throw, a release that fails on the success arm — the
 * mark-before-`fn` ordering, the stderr `run-lock.acquire` contract line, and
 * the cross-process refusal a second invocation must get while a first one
 * holds `<runId>.lock` (real contention via `Bun.spawn`, not a stubbed `claim`).
 *
 * The module parks its `held`/`destructive` state on `globalThis` and registers
 * its signal handler on first acquire, so every test acquires into its OWN
 * mkdtemp'd directory (no two tests share a lock path) and releases what it
 * acquires; the destructive-throw test performs the operator-judged
 * `clearRunLockDestructive` + release in a `finally` so neither the mark nor
 * the `held` entry leaks into a later test in this process.
 */

import { describe, expect, test, afterEach, beforeEach, spyOn } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as nodeFs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  acquireRunLock,
  clearRunLockDestructive,
  markRunLockDestructive,
  releaseHeldRunLocks,
  releaseRunLock,
  RunLockReentrantError,
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
    try {
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
    } finally {
      // A failed expect inside fn throws out of the wrapper's leave-for-operator
      // arm, which strands the mark AND the lock file for this process — the
      // sibling destructive-throw test's cleanup is what a `finally` buys here:
      // operator-judged clear + release, both no-ops on the success path (the
      // mark was cleared and the lock released already).
      clearRunLockDestructive(lockPath());
      releaseRunLock(lockPath());
    }

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
      // `process.execPath`, not bare "bun": a version manager's shim on PATH can
      // differ from the interpreter running this suite, and the test would then
      // report a failure of THAT bun as a failure of the lock.
      const child = Bun.spawn([process.execPath, "-e", childCode], {
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

  test("a bare string is not a RunLockHandle — the COMPILER refuses it, the runtime cannot", () => {
    // @ts-expect-error — the brand's whole point: no string literal or resolve()
    // output satisfies RunLockHandle, and there is no exported cast helper. bun
    // strips types without checking, so `tsc --noEmit` is the gate that fails
    // if the brand is ever loosened.
    const forged: RunLockHandle = lockPath();
    // There is NO runtime refusal to assert, and pretending otherwise would
    // prove the opposite of the title: at runtime the brand is erased, a handle
    // IS the path string, and the module documents that a hand-joined string
    // reaching the release primitives "no-ops or refuses silently" — the silent
    // no-op is precisely the hazard only the type system closes. So the runtime
    // half pins that documented posture: the forged (never-claimed) string
    // releases as a silent no-op — no throw, nothing created behind the
    // caller's back.
    expect(() => releaseRunLock(forged)).not.toThrow();
    expect(existsSync(lockPath())).toBeFalse();
  });

  test("wrapping a closure that re-acquires the SAME lock throws RunLockReentrantError (the GateDeps.teardown wiring rule)", async () => {
    // approval-gate.ts's `GateDeps.teardown` docblock: the wired seam runs
    // inside a caller that already holds the run lock, so wrapping it in
    // `withRunLock` "would throw RunLockReentrantError". That claim is this
    // module's to pin — the wrapper inherits `acquireRunLock`'s re-entrancy
    // guard, not a weaker contention refusal — and the OUTER invocation must
    // still release cleanly after catching the inner one.
    let inner: RunLockReentrantError | undefined;
    const outer = await withRunLock(dir, RUN_ID, "outer", async () => {
      try {
        await withRunLock(dir, RUN_ID, "inner", async () => "unreachable");
      } catch (e) {
        inner = e as RunLockReentrantError;
      }
      return "outer-ok";
    });

    expect(outer).toBe("outer-ok");
    expect(inner).toBeInstanceOf(RunLockReentrantError);
    expect(inner?.code).toBe("run-lock-reentrant");
    // The inner refusal wedged nothing: the outer release ran, and the run
    // acquires again for the next verb.
    expect(existsSync(lockPath())).toBeFalse();
    releaseRunLock(acquireRunLock(dir, RUN_ID, "test"));
    expect(existsSync(lockPath())).toBeFalse();
  });

  test("a release failure after fn resolves PROPAGATES — the success arm never swallows it", async () => {
    // fn RESOLVED, but the lock was no longer this invocation's when the
    // wrapper reached for it: the body was swapped mid-flight (the real shape
    // is the operator's `rm` plus a second invocation's re-claim; a write
    // injects it deterministically). `releaseRunLock` refuses, and with
    // `completed` latched the wrapper rethrows — reporting success while the
    // run stays locked to a stranger would be the silent half of the same bug.
    let resolved = false;
    let releaseFailure: Error | undefined;
    try {
      await withRunLock(dir, RUN_ID, "test", async (handle) => {
        writeFileSync(handle, "someone else's claim\n");
        resolved = true;
      });
    } catch (e) {
      releaseFailure = e as Error;
    }

    expect(resolved).toBeTrue();
    expect(releaseFailure?.message).toContain("refusing to release");
    expect(releaseFailure?.message).toContain("not this invocation's claim");
    // The refusal proved the lock not-ours and dropped its registration; the
    // foreign claim is left exactly where it is — nothing here steals it.
    expect(existsSync(lockPath())).toBeTrue();
    expect(readFileSync(lockPath(), "utf8")).toContain("someone else's claim");
    // The registration really was dropped: a release now is a silent no-op,
    // where a kept entry would re-read the foreign body and throw the mismatch.
    expect(() => releaseRunLock(lockPath())).not.toThrow();
  });

  test("the acquire line: one stderr JSON per attempt, outcome classified acquired/refused-stale/refused-busy", async () => {
    // DF2.11's Observability Contract line, logged at settle. Captured through
    // the module's own sink — fd 2 via node:fs's `writeSync`, not
    // `process.stderr.write`, which the raw loop bypasses — with the spy
    // swallowing the bytes so the assertions never race bun's own output.
    // Tolerant of extra fields: the contract pins shape and values, never an
    // exhaustive key set.
    const realWrite = nodeFs.writeSync as (...a: unknown[]) => number;
    const chunks: string[] = [];
    const spy = spyOn(nodeFs, "writeSync").mockImplementation(((fd: number, data: string | Uint8Array, off?: number, len?: number) => {
      if (fd === 2) {
        const text =
          typeof data === "string"
            ? data
            : new TextDecoder().decode(data.subarray(off ?? 0, (off ?? 0) + (len ?? data.byteLength)));
        chunks.push(text);
        return len ?? (typeof data === "string" ? data.length : data.byteLength);
      }
      return realWrite(fd, data, off, len);
    }) as typeof nodeFs.writeSync);

    try {
      // acquired — with a caller-threaded requestId, and fn resolved so the
      // release half of the posture also runs under the capture.
      await withRunLock(dir, RUN_ID, "acq-holder", async () => "ok", { requestId: "req-acq-1" });

      // refused-stale — a provably dead same-host holder. `stale` is read off
      // `RunLockedError.stale`, the same flag that drives the `rm` advice, so
      // the line and the refusal prose can never disagree.
      const probe = acquireRunLock(dir, "host-probe");
      const host = readFileSync(probe, "utf8").trim().split(/\s+/)[1] ?? "";
      releaseRunLock(probe);
      writeFileSync(lockPath(), `999999999 ${host} ${new Date().toISOString()} feedface\n`, { flag: "wx" });
      let staleRefusal: RunLockedError | undefined;
      try {
        await withRunLock(dir, RUN_ID, "acq-holder", async () => "unreachable");
      } catch (e) {
        staleRefusal = e as RunLockedError;
      }
      expect(staleRefusal).toBeInstanceOf(RunLockedError);
      expect(staleRefusal?.stale).toBeTrue();

      // refused-busy — this process ALREADY holds the lock: the re-entrancy
      // refusal is not a RunLockedError and lands in the contract's other
      // refusal flavor.
      const ours = acquireRunLock(dir, "busy-probe");
      let busyError: unknown;
      try {
        await withRunLock(dir, "busy-probe", "acq-holder", async () => "unreachable");
      } catch (e) {
        busyError = e;
      }
      expect(busyError).toBeInstanceOf(RunLockReentrantError);
      releaseRunLock(ours);

      const lines = chunks.filter((c) => c.includes('"run-lock.acquire"'));
      expect(lines.length).toBe(3); // exactly one line per acquire attempt
      const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
      const byOutcome = (outcome: string): Record<string, unknown> => {
        const hits = parsed.filter((p) => p.outcome === outcome);
        expect(hits.length).toBe(1);
        const hit = hits[0];
        if (hit === undefined) throw new Error(`no "${outcome}" acquire line captured`);
        return hit;
      };

      const acquired = byOutcome("acquired");
      expect(acquired.operation).toBe("run-lock.acquire");
      expect(acquired.requestId).toBe("req-acq-1");
      expect(acquired.runId).toBe(RUN_ID);
      expect(acquired.holder).toBe("acq-holder");
      expect(typeof acquired.durationMs).toBe("number");

      const stale = byOutcome("refused-stale");
      expect(stale.operation).toBe("run-lock.acquire");
      expect(stale.runId).toBe(RUN_ID);
      expect(stale.holder).toBe("acq-holder");
      // No caller requestId: the contract's `-` fallback.
      expect(stale.requestId).toBe("-");

      const busy = byOutcome("refused-busy");
      expect(busy.operation).toBe("run-lock.acquire");
      expect(busy.runId).toBe("busy-probe");
      expect(busy.holder).toBe("acq-holder");
    } finally {
      spy.mockRestore(); // real stderr resumes for any failure output below
      // Whatever happened above: no stale body left for the exit handler to
      // report on, and nothing held (the re-entrant release above is the only
      // registration this test leaves).
      rmSync(lockPath(), { force: true });
    }
  });
});
