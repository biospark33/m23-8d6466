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

      // Discriminating fields, not the whole payload — additive informative
      // fields on the outcome are a contract extension, not a break.
      expect(out.outcome).toBe("rebound");
      expect(out).toMatchObject({ supersededReportId: "rv-1" });
      const ext = s.store.get("run-1").extensions?.approval;
      expect(ext?.state).toBe("awaiting-approval");
      expect(ext?.reportId).toBe("rv-2");
      expect(ext?.headSha).toBe("b".repeat(40));
      // The RECORD keeps the full ordered history; the singular
      // `supersededReportId` on the OUTCOME is the id THIS rebind displaced —
      // derived per-call from the record's prior `reportId`, not from the
      // array (approval-gate reads `existing?.reportId` before appending it).
      // Only one stored history exists, so a record whose scalar and array
      // disagree is impossible rather than unfalsifiable.
      expect(ext?.supersededReportIds).toEqual(["rv-1"]);
      // Key-set check, not field access: a field read cannot see an EXTRA key,
      // so the retired scalar surviving beside the array would be invisible to
      // the assertion above. This is the sibling of approval-gate.test.ts's
      // migration check — the writer must never re-emit it either.
      expect(ext).not.toHaveProperty("supersededReportId");
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

      // Same replacement race as above, but this time the restore LINK that
      // puts the replacement lock back (claimPath → lockPath — `link` is the
      // atomic restore-if-absent; there is no rename to clobber with) fails
      // with a transient I/O error — after this process has already renamed
      // lockPath onto its own claimPath. That failure must propagate (fail
      // closed) instead of being swallowed and retried: swallowing it would
      // free lockPath for a subsequent acquisition while the replacement
      // holder's content is stranded at claimPath, letting two callers both
      // believe they hold the lock.
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

      // Only the RESTORE link (claimPath → lockPath, after this process has
      // renamed lockPath onto its own claimPath) must fail — the initial
      // claim rename (lockPath → claimPath) must go through untouched, or the
      // test would never reach the restore path at all. `linkSync` is called
      // nowhere else on this path, so spying it alone gates the injection, and
      // the gate anchors BOTH sides: the source is THIS run's claim (the
      // module mints `${lockPath}.claim.<pid>.<uuid>`, so the prefix plus the
      // exact destination pins the one restore call) and the destination is
      // THIS run's lock path. A bare `.claim.` substring anywhere would fire
      // on any link whose source merely contains it.
      const realLinkSync = fs.linkSync;
      const linkSpy = spyOn(fs, "linkSync").mockImplementation(((...args: Parameters<typeof fs.linkSync>) => {
        if (String(args[0]).startsWith(`${lock}.claim.`) && args[1] === lock) {
          const err = new Error("simulated transient I/O error") as NodeJS.ErrnoException;
          err.code = "EIO";
          throw err;
        }
        return realLinkSync(...args);
      }) as typeof fs.linkSync);

      try {
        await expect(recordApprovalPort(s.store).requestApproval("run-1", req("rv-1"))).rejects.toThrow(
          /approval lock reclaim: failed to restore/,
        );
      } finally {
        linkSpy.mockRestore();
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

  test(
    "a follow-up request while the stranded capture persists is REFUSED (fail-closed is a property, not a throw)",
    async () => {
      // DEFECT FIXED (round 7 T-D canary, verified against src 2026-08-30):
      // the restore-failure arm above throws out of the FIRST call — but the
      // reclaim's `renameSync` has already vacated `lockPath`, and the fix now
      // re-poisons it (a pid-less `0:<uuid>` marker the dead-pid reclaim door
      // never auto-reclaims) before rethrowing. So the NEXT request cannot `wx`
      // its way in and run `body()` while the replacement holder may still be
      // inside ITS `body()` — the two-in-the-critical-section shape the gate's
      // own reclaim comments name as the cardinal sin. The follow-up instead
      // waits out the lock timeout and fails with the `fleet unlock` remedy.
      // (This test began life as a `test.failing` canary: green meant the
      // defect was live. The poison-on-restore-failure fix turned it into an
      // ordinary test.)
      const s = store();
      try {
        s.store.create("run-1");
        const lock = path.join(s.dir, "run-1.approval.lock");
        const dead = spawnSync(process.execPath, ["--version"]);
        const deadContent = `${dead.pid}:stale-nonce`;
        fs.writeFileSync(lock, deadContent);
        const old = new Date(Date.now() - 60_000);
        fs.utimesSync(lock, old, old);

        const liveContent = `${process.pid}:replacement-nonce`;
        const realReadFileSync = fs.readFileSync;
        let injected = false;
        const readSpy = spyOn(fs, "readFileSync").mockImplementation((
          (...args: Parameters<typeof fs.readFileSync>) => {
            const result = realReadFileSync(...args);
            if (!injected && args[0] === lock && result === deadContent) {
              injected = true;
              fs.writeFileSync(lock, liveContent, { mode: 0o600 });
            }
            return result;
          }
        ) as typeof fs.readFileSync);
        // Same anchored gate as the test above: only THIS run's
        // claim→lockPath restore link fails.
        const realLinkSync = fs.linkSync;
        const linkSpy = spyOn(fs, "linkSync").mockImplementation(((...args: Parameters<typeof fs.linkSync>) => {
          if (String(args[0]).startsWith(`${lock}.claim.`) && args[1] === lock) {
            const err = new Error("simulated transient I/O error") as NodeJS.ErrnoException;
            err.code = "EIO";
            throw err;
          }
          return realLinkSync(...args);
        }) as typeof fs.linkSync);
        const port = recordApprovalPort(s.store);
        try {
          await expect(port.requestApproval("run-1", req("rv-1"))).rejects.toThrow(
            /approval lock reclaim: failed to restore/,
          );
        } finally {
          linkSpy.mockRestore();
          readSpy.mockRestore();
        }

        // THE PROPERTY: while the replacement holder's content is stranded at
        // the claim path, a follow-up must be refused — never bind. A
        // catch-all would accept ANY rejection (an incidental TypeError from a
        // broken implementation passes), so the message is matched against the
        // lock-timeout text the wait-out path produces AND the poison marker
        // the fix is asserted to leave behind. A request that binds, or a
        // rejection whose cause is anything other than the timed-out wait on
        // the poisoned path, fails here.
        let followUp: unknown;
        try {
          followUp = await port.requestApproval("run-1", req("rv-2", "b".repeat(40)));
        } catch (e) {
          followUp = `refused: ${(e as Error).message}`;
        }
        const refusal = String(followUp);
        expect(refusal).toMatch(/^refused: approval lock .* held for over/);
        // The poison is the actual mutual-exclusion protection — asserted
        // directly, not inferred from the refusal: a pid-less marker the
        // dead-pid reclaim door never auto-reclaims, sitting ON the lock path.
        const poison = fs.readFileSync(lock, "utf8");
        expect(poison).toMatch(/^0:[0-9a-f-]{36}$/);
        // And the refusal left the stranded state untouched for the operator.
        const leftovers = fs.readdirSync(s.dir).filter((f) => f.includes(".claim."));
        expect(leftovers.length).toBe(1);
        expect(fs.readFileSync(path.join(s.dir, leftovers[0]!), "utf8")).toBe(liveContent);
        expect(s.store.get("run-1").extensions?.approval).toBeUndefined();
      } finally {
        s.cleanup();
      }
    },
    // TWO sequential real waits (the first call's reclaim plus the follow-up's
    // LOCK_TIMEOUT_MS wait-out) against real fs and real Date.now() math: 15s
    // leaves a loaded CI runner the smaller share of its budget on the second
    // wait, so the ceiling is the lock timeout doubled with headroom.
    30_000,
  );

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

describe("bundle guard — the wired bundleDir (DF3.4 Deviation 8)", () => {
  test("with bundleDir wired, a first request whose bundle is gone is refused and binds nothing", async () => {
    const s = store();
    try {
      s.store.create("run-1");
      await expect(
        recordApprovalPort(s.store, { bundleDir: s.dir }).requestApproval("run-1", req("rv-1")),
      ).rejects.toThrow(/cannot pause run-1: its harvested bundle is gone/);
      expect(s.store.get("run-1").extensions?.approval).toBeUndefined();
    } finally {
      s.cleanup();
    }
  });

  test("an EMPTY bundle file still passes the guard — the gate's contract is existence, not content", async () => {
    // The refusal exists to stop a report being bound to a run whose bundle
    // was REMOVED; whether the bytes inside are a real bundle is harvest's
    // invariant, and it IS tested — tests/providers/harvest.test.ts pins
    // `git bundle verify` running on the copied file before fetch, so a
    // hollow or truncated bundle never survives a real harvest to reach this
    // guard. Pinning the hollow case here keeps the guard from drifting into
    // content sniffing, which no caller asked for and every caller would pay
    // for.
    const s = store();
    try {
      s.store.create("run-1");
      fs.writeFileSync(path.join(s.dir, "run-1.bundle"), "");
      expect((await recordApprovalPort(s.store, { bundleDir: s.dir }).requestApproval("run-1", req("rv-1"))).outcome).toBe(
        "requested",
      );
      expect(s.store.get("run-1").extensions?.approval?.state).toBe("awaiting-approval");
    } finally {
      s.cleanup();
    }
  });

  test("with bundleDir wired and the bundle present, first request and rebind both pass the guard", async () => {
    const s = store();
    try {
      s.store.create("run-1");
      fs.writeFileSync(path.join(s.dir, "run-1.bundle"), "bundle");
      const port = recordApprovalPort(s.store, { bundleDir: s.dir });
      expect((await port.requestApproval("run-1", req("rv-1"))).outcome).toBe("requested");
      // The rebind's discriminating fields, not the whole payload: the
      // contract here is the outcome and WHICH id this call displaced. A
      // strict `toEqual` would fail on any additive, informative field the
      // outcome later carries (a stamp, a history echo) — indistinguishable
      // from a behavioral break.
      const rebind = await port.requestApproval("run-1", req("rv-2", "b".repeat(40)));
      expect(rebind.outcome).toBe("rebound");
      expect(rebind).toMatchObject({ supersededReportId: "rv-1" });
    } finally {
      s.cleanup();
    }
  });

  test("with bundleDir wired, removing the bundle between pauses refuses the rebind and keeps the live binding", async () => {
    const s = store();
    try {
      s.store.create("run-1");
      const bundle = path.join(s.dir, "run-1.bundle");
      fs.writeFileSync(bundle, "bundle");
      const port = recordApprovalPort(s.store, { bundleDir: s.dir });
      await port.requestApproval("run-1", req("rv-1"));
      fs.rmSync(bundle);

      await expect(port.requestApproval("run-1", req("rv-2", "b".repeat(40)))).rejects.toThrow(
        /cannot rebind run-1: its harvested bundle is gone/,
      );
      // The refusal binds nothing and appends nothing: the live binding is
      // intact AND the audit history never grows on a refused rebind.
      const ext = s.store.get("run-1").extensions?.approval;
      expect(ext?.reportId).toBe("rv-1");
      expect(ext?.supersededReportIds).toEqual([]);
    } finally {
      s.cleanup();
    }
  });
});
