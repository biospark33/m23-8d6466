/**
 * Approval port tests (Story DF5.1, AC6).
 *
 * DF5.1 is the SINGLE OWNER of the `requestApproval` caller. The port is the
 * seam DF3.4 lands behind; the state machine asserted here is the caller-side
 * contract that must hold whichever adapter is plugged in.
 */
import { describe, expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { RunRecordStore } from "../../src/providers/run-record.ts";
import { recordApprovalPort } from "../../src/reverify/approval.ts";

function store(): { store: RunRecordStore; dir: string; cleanup(): void } {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "rv-runs-"));
  return {
    dir,
    store: new RunRecordStore({ dir }),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

const req = (reportId: string, headSha = "a".repeat(40)) => ({
  proposal: "open a PR for run-1",
  reportId,
  headSha,
});

describe("recordApprovalPort", () => {
  test("first green verdict registers an awaiting-approval record", async () => {
    const s = store();
    try {
      s.store.create("run-1");
      const port = recordApprovalPort(s.store);
      const out = await port.requestApproval("run-1", req("rv-1"));
      expect(out.outcome).toBe("requested");

      const ext = s.store.get("run-1").extensions?.approval;
      expect(ext?.state).toBe("awaiting-approval");
      expect(ext?.reportId).toBe("rv-1");
    } finally {
      s.cleanup();
    }
  });

  test("a second green verdict REBINDS the awaiting record, creating no second one", async () => {
    const s = store();
    try {
      s.store.create("run-1");
      const port = recordApprovalPort(s.store);
      await port.requestApproval("run-1", req("rv-1", "a".repeat(40)));
      const out = await port.requestApproval("run-1", req("rv-2", "b".repeat(40)));

      expect(out).toEqual({ outcome: "rebound", supersededReportId: "rv-1" });
      const ext = s.store.get("run-1").extensions?.approval;
      expect(ext?.state).toBe("awaiting-approval");
      expect(ext?.reportId).toBe("rv-2");
      expect(ext?.headSha).toBe("b".repeat(40));
      expect(ext?.supersededReportId).toBe("rv-1");
    } finally {
      s.cleanup();
    }
  });

  test("a pausing record is left byte-identical and no request is made", async () => {
    const s = store();
    try {
      s.store.create("run-1");
      s.store.set("run-1", {
        extensions: {
          approval: { state: "pausing", proposal: "p", reportId: "rv-0", headSha: "c".repeat(40), requestedAt: "t0" },
        },
      });
      const before = fs.readFileSync(s.store.path("run-1"), "utf8");

      const out = await recordApprovalPort(s.store).requestApproval("run-1", req("rv-9"));
      expect(out).toEqual({ outcome: "pause-in-progress" });
      expect(fs.readFileSync(s.store.path("run-1"), "utf8")).toBe(before);
    } finally {
      s.cleanup();
    }
  });

  test.each([["approved"], ["rejected"], ["timed-out"]] as const)(
    "a terminal record (%s) is not rebound and no request is made",
    async (state: string) => {
      const s = store();
      try {
        s.store.create("run-1");
        s.store.set("run-1", {
          extensions: {
            approval: { state, proposal: "p", reportId: "rv-0", headSha: "c".repeat(40), requestedAt: "t0" },
          },
        });
        const before = fs.readFileSync(s.store.path("run-1"), "utf8");

        const out = await recordApprovalPort(s.store).requestApproval("run-1", req("rv-9"));
        expect(out).toEqual({ outcome: "already-decided", state });
        expect(fs.readFileSync(s.store.path("run-1"), "utf8")).toBe(before);
      } finally {
        s.cleanup();
      }
    },
  );

  test("works on a CLOSED record — the pause happens after teardown", async () => {
    const s = store();
    try {
      s.store.create("run-1");
      s.store.close("run-1");
      const out = await recordApprovalPort(s.store).requestApproval("run-1", req("rv-1"));
      expect(out.outcome).toBe("requested");
      expect(s.store.get("run-1").extensions?.approval?.state).toBe("awaiting-approval");
    } finally {
      s.cleanup();
    }
  });

  test("concurrent requests serialize — exactly one binding survives, no second record", async () => {
    const s = store();
    try {
      s.store.create("run-1");
      const port = recordApprovalPort(s.store);
      const outs = await Promise.all([
        port.requestApproval("run-1", req("rv-a")),
        port.requestApproval("run-1", req("rv-b")),
      ]);
      const kinds = outs.map((o) => o.outcome).sort();
      expect(kinds).toEqual(["rebound", "requested"]);
      const ext = s.store.get("run-1").extensions?.approval;
      expect(["rv-a", "rv-b"]).toContain(String(ext?.reportId));
      expect(ext?.state).toBe("awaiting-approval");
    } finally {
      s.cleanup();
    }
  });
});

describe("approval lock", () => {
  test("a lock left behind by a DEAD holder is stolen once it is stale", async () => {
    const s = store();
    try {
      s.store.create("run-1");
      const lock = path.join(s.dir, "run-1.approval.lock");
      // spawnSync blocks until the child exits, so its pid is guaranteed dead
      // by the time we write it into the lock — proof of death, not guesswork.
      const dead = spawnSync(process.execPath, ["--version"]);
      fs.writeFileSync(lock, `${dead.pid}:stale-nonce`);
      // Backdate past the timeout: the holder is gone, not slow.
      const old = new Date(Date.now() - 60_000);
      fs.utimesSync(lock, old, old);

      const out = await recordApprovalPort(s.store).requestApproval("run-1", req("rv-1"));
      expect(out.outcome).toBe("requested");
      expect(fs.existsSync(lock)).toBe(false);
    } finally {
      s.cleanup();
    }
  });

  test("a lock held by a LIVE process is NOT reclaimed by age alone", async () => {
    const s = store();
    try {
      s.store.create("run-1");
      const lock = path.join(s.dir, "run-1.approval.lock");
      // Own pid is verifiably alive (it's this test process), yet the file is
      // backdated well past LOCK_STALE_MS: a suspended-but-live holder must
      // still block a second requester from entering the critical section.
      fs.writeFileSync(lock, `${process.pid}:still-alive`);
      const old = new Date(Date.now() - 60_000);
      fs.utimesSync(lock, old, old);

      await expect(recordApprovalPort(s.store).requestApproval("run-1", req("rv-1"))).rejects.toThrow(
        /approval lock .* held for over/,
      );
      expect(fs.existsSync(lock)).toBe(true);
    } finally {
      s.cleanup();
    }
  }, 15_000);

  test("a replacement lock racing in between the ownership check and removal is NOT destroyed", async () => {
    const s = store();
    try {
      s.store.create("run-1");
      const lock = path.join(s.dir, "run-1.approval.lock");
      // spawnSync blocks until the child exits, so its pid is guaranteed dead
      // by the time we write it into the lock — proof of death, not guesswork.
      const dead = spawnSync(process.execPath, ["--version"]);
      const deadContent = `${dead.pid}:stale-nonce`;
      fs.writeFileSync(lock, deadContent);
      const old = new Date(Date.now() - 60_000);
      fs.utimesSync(lock, old, old);

      // Simulate a second racer: right after this process reads the dead
      // holder's content (proving death) but before it can act on it, a
      // fresh, live holder replaces the lock file in place. The rename-based
      // reclaim must detect the content mismatch and put the replacement
      // back rather than deleting it.
      const liveContent = `${process.pid}:replacement-nonce`;
      const realReadFileSync = fs.readFileSync;
      let injected = false;
      const spy = spyOn(fs, "readFileSync").mockImplementation(((...args: Parameters<typeof fs.readFileSync>) => {
        const result = realReadFileSync(...args);
        if (!injected && args[0] === lock && result === deadContent) {
          injected = true;
          fs.writeFileSync(lock, liveContent, { mode: 0o600 });
        }
        return result;
      }) as typeof fs.readFileSync);

      try {
        await expect(recordApprovalPort(s.store).requestApproval("run-1", req("rv-1"))).rejects.toThrow(
          /approval lock .* held for over/,
        );
      } finally {
        spy.mockRestore();
      }

      // The replacement lock must survive untouched — it was never the dead
      // holder's lock, so it must never have been unlinked.
      expect(fs.existsSync(lock)).toBe(true);
      expect(fs.readFileSync(lock, "utf8")).toBe(liveContent);
    } finally {
      s.cleanup();
    }
  }, 15_000);

  test("a restore failure after a successful claim fails closed, not open", async () => {
    const s = store();
    try {
      s.store.create("run-1");
      const lock = path.join(s.dir, "run-1.approval.lock");
      const dead = spawnSync(process.execPath, ["--version"]);
      const deadContent = `${dead.pid}:stale-nonce`;
      fs.writeFileSync(lock, deadContent);
      const old = new Date(Date.now() - 60_000);
      fs.utimesSync(lock, old, old);

      // Same replacement race as above, but this time the restore write that
      // puts the replacement lock back fails with something other than
      // EEXIST (e.g. a transient I/O error) — after this process has already
      // renamed lockPath onto its own claimPath. That failure must propagate
      // (fail closed) instead of being swallowed and retried: swallowing it
      // would free lockPath for a subsequent acquisition while the
      // replacement holder's content is stranded at claimPath, letting two
      // callers both believe they hold the lock.
      const liveContent = `${process.pid}:replacement-nonce`;
      const realReadFileSync = fs.readFileSync;
      let injected = false;
      const readSpy = spyOn(fs, "readFileSync").mockImplementation(((
        ...args: Parameters<typeof fs.readFileSync>
      ) => {
        const result = realReadFileSync(...args);
        if (!injected && args[0] === lock && result === deadContent) {
          injected = true;
          fs.writeFileSync(lock, liveContent, { mode: 0o600 });
        }
        return result;
      }) as typeof fs.readFileSync);

      // Only the RESTORE write (after this process has renamed lockPath onto
      // its own claimPath) must fail — the initial "wx" claim attempt at the
      // top of the loop, and the injected replacement write above, must go
      // through untouched, or the test would never reach the reclaim path at
      // all. `pastRename` gates that.
      let pastRename = false;
      const realRenameSync = fs.renameSync;
      const renameSpy = spyOn(fs, "renameSync").mockImplementation(((
        ...args: Parameters<typeof fs.renameSync>
      ) => {
        const result = realRenameSync(...args);
        pastRename = true;
        return result;
      }) as typeof fs.renameSync);

      const realWriteFileSync = fs.writeFileSync;
      const writeSpy = spyOn(fs, "writeFileSync").mockImplementation(((
        ...args: Parameters<typeof fs.writeFileSync>
      ) => {
        if (pastRename && args[0] === lock) {
          const err = new Error("simulated transient I/O error") as NodeJS.ErrnoException;
          err.code = "EIO";
          throw err;
        }
        return realWriteFileSync(...args);
      }) as typeof fs.writeFileSync);

      try {
        await expect(recordApprovalPort(s.store).requestApproval("run-1", req("rv-1"))).rejects.toThrow(
          /approval lock reclaim: failed to restore/,
        );
      } finally {
        writeSpy.mockRestore();
        renameSpy.mockRestore();
        readSpy.mockRestore();
      }

      // Fail closed, not open: `body()` (the read-decide-write against the
      // run record) must never have run. Before the fix, the swallowed
      // restore error let this SAME call's loop fall through, re-acquire the
      // now-empty lockPath on its next iteration, and enter the critical
      // section anyway — despite the replacement holder's lock content being
      // stranded at claimPath. The rejection above is the fix; this confirms
      // no approval record was written as a side effect of that wrongly
      // continued loop.
      expect(s.store.get("run-1").extensions?.approval).toBeUndefined();

      // The replacement holder's content is preserved (at claimPath, not
      // discarded) so an operator can recover it by hand, per the error
      // message above naming claimPath.
      const claimLeftovers = fs.readdirSync(s.dir).filter((f) => f.includes(".claim."));
      expect(claimLeftovers.length).toBe(1);
      expect(fs.readFileSync(path.join(s.dir, claimLeftovers[0]!), "utf8")).toBe(liveContent);
    } finally {
      s.cleanup();
    }
  }, 15_000);

  test("a FRESH lock is waited on, then times out rather than being stolen", async () => {
    const s = store();
    try {
      s.store.create("run-1");
      fs.writeFileSync(path.join(s.dir, "run-1.approval.lock"), "");
      await expect(recordApprovalPort(s.store).requestApproval("run-1", req("rv-1"))).rejects.toThrow(
        /approval lock .* held for over/,
      );
    } finally {
      s.cleanup();
    }
  }, 15_000);
});
