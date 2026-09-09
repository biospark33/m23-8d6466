/**
 * DF3.4 W4: the tier-1 pre-PR approval gate (AC1/AC2/AC3).
 *
 * The make-or-break is ORDER, not outcome: `pausing` is registered BEFORE
 * teardown and promoted to `awaiting-approval` only after it returns, so a
 * crash in between leaves a record naming the run and its bound report. Every
 * order test therefore captures the SEQUENCE — a teardown that reports the
 * state it observed — because an implementation that tears down first passes
 * every outcome-only assertion.
 *
 * `store()` factory + try/finally, no beforeEach and no env vars, matching
 * tests/reverify/approval.test.ts.
 */
import { describe, expect, setSystemTime, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { RunRecordStore } from "../../src/providers/run-record.ts";
import { createRun } from "../../src/providers/driver.ts";
import { FakeDriver } from "../../src/providers/fake-driver.ts";
import { teardownSandbox } from "../../src/providers/teardown.ts";
import {
  acquireRunLock,
  releaseRunLock,
  RunLockReentrantError,
  withRunLock,
} from "../../scripts/lib/run-lock.ts";
import { setLogSink, type LogEntry } from "../../src/swarmclaw/log.ts";
import {
  awaitDecision,
  DEFAULT_TIMEOUT_MS,
  expiredState,
  HEAD_SHA_RE,
  MAX_APPROVER_ID_CHARS,
  MAX_PROPOSAL_CHARS,
  MAX_REASON_CHARS,
  MAX_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
  reclaimApprovalLock,
  requestApproval,
  submitDecision,
  sweepExpired,
  TIMEOUT_APPROVER_ID,
  withApprovalLock,
  type GateDeps,
} from "../../src/fleet/approval-gate.ts";

function store(): { store: RunRecordStore; dir: string; cleanup(): void } {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "qds-gate-"));
  return {
    dir,
    store: new RunRecordStore({ dir }),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

/** For the cross-process arms: absolute, because a child's cwd is not ours. */
const REPO_SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "src");

/**
 * What `process.kill(1, 0)` raises in THIS environment, probed once. The
 * EPERM liveness test below gets its EPERM from pid 1 being owned by another
 * user — true for a non-root process on a shared host, FALSE as root (the
 * default in Docker CI) or in a user-owned pid namespace, where the probe
 * succeeds and the EPERM arm of `isLockHolderDead` is never exercised.
 */
const pid1Probe = ((): string | undefined => {
  try {
    process.kill(1, 0);
    return undefined; // signallable — no EPERM is obtainable in this environment
  } catch (e) {
    return String((e as NodeJS.ErrnoException).code);
  }
})();
if (pid1Probe !== "EPERM") {
  // Loud, because a silently-skipped test reads exactly like a passing one.
  console.error(
    `approval-gate EPERM liveness test SKIPPED: kill(1, 0) gave ${pid1Probe ?? "success"}, not EPERM (running as root or a user-owned pid namespace) — the EPERM arm of isLockHolderDead is NOT exercised here`,
  );
}

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const req = (reportId: string, headSha = SHA_A) => ({ proposal: "open a PR", reportId, headSha });

/**
 * A teardown that records the runId it was HANDED and the approval state it
 * OBSERVED — the order probe. The runId is deliberately part of every entry: a
 * seam invoked with the wrong id (a reportId, a shifted argument) passes every
 * outcome and state assertion in this file while production destroys the wrong
 * box, so each entry names the run it was actually pointed at.
 */
function recordingTeardown(s: RunRecordStore, log: string[]): (runId: string) => Promise<void> {
  return async (runId) => {
    log.push(`teardown:${runId}:${String(s.get(runId).extensions?.approval?.state)}`);
  };
}

const deps = (s: RunRecordStore, extra: Partial<GateDeps> = {}): GateDeps => ({ store: s, ...extra });

/**
 * Plant the record a crash between (a) register and (c) promote leaves behind.
 * One shape, seven tests — the fields are the record's own contract, so a
 * rename would have to touch every arm anyway; what is deduplicated here is
 * the six-line literal, not a decision.
 */
function seedPausing(
  s: RunRecordStore,
  runId: string,
  reportId: string,
  opts: { headSha?: string; requestedAt?: string; expiresAt?: string } = {},
): void {
  s.set(runId, {
    extensions: {
      approval: {
        state: "pausing",
        proposal: "p",
        reportId,
        headSha: opts.headSha ?? SHA_A,
        requestedAt: opts.requestedAt ?? "2026-08-28T12:00:00.000Z",
        expiresAt: opts.expiresAt ?? "2099-01-01T00:00:00.000Z",
        supersededReportIds: [],
      },
    },
  });
}

describe("AC1 — requestApproval registers BEFORE teardown and promotes after", () => {
  test("the order is pausing → teardown → awaiting-approval", async () => {
    const s = store();
    try {
      s.store.create("run-1");
      const log: string[] = [];
      const out = await requestApproval(deps(s.store, { teardown: recordingTeardown(s.store, log) }), "run-1", req("rv-1"));

      expect(out).toEqual({ outcome: "requested" });
      // The NEGATIVE CONTROL: an implementation that tears down before
      // registering observes `undefined` here and fails on this line alone,
      // while passing every outcome assertion in this file.
      expect(log).toEqual(["teardown:run-1:pausing"]);
      expect(s.store.get("run-1").extensions?.approval?.state).toBe("awaiting-approval");
    } finally {
      s.cleanup();
    }
  });

  test("teardown runs with noHarvest, on THIS run's id — the wrong id destroys the wrong box", async () => {
    const s = store();
    try {
      s.store.create("run-1");
      const seen: Array<{ id: string; opts: { noHarvest: boolean } }> = [];
      await requestApproval(
        deps(s.store, {
          teardown: async (id, opts) => {
            seen.push({ id, opts });
          },
        }),
        "run-1",
        req("rv-1"),
      );
      // The SEAM'S ARGUMENT, pinned: the id reaching `deps.teardown` is the
      // run's own id, not the reportId or a shifted argument.
      expect(seen).toEqual([{ id: "run-1", opts: { noHarvest: true } }]);
    } finally {
      s.cleanup();
    }
  });

  test("a crash during teardown leaves a RECOVERABLE pausing extension, not a lost run", async () => {
    const s = store();
    try {
      s.store.create("run-1");
      const boom = deps(s.store, {
        teardown: async () => {
          throw new Error("box destroy failed");
        },
      });
      let err: unknown;
      try {
        await requestApproval(boom, "run-1", req("rv-1"));
      } catch (e) {
        err = e;
      }
      // T16: the error SHAPE, not just a substring. The gate re-raises whatever
      // the seam threw — no "approval" wrapper, no prefix, no re-wrap — because
      // the remediation lives in the provider's own message and a wrapped copy
      // splits the hunt for it across two shapes.
      expect((err as Error).message).toBe("box destroy failed");

      const ext = s.store.get("run-1").extensions?.approval;
      expect(ext?.state).toBe("pausing");
      expect(ext?.reportId).toBe("rv-1");
      expect(ext?.headSha).toBe(SHA_A);
    } finally {
      s.cleanup();
    }
  });

  test("the fresh registration carries the bound pair, an expiry and an empty history", async () => {
    const s = store();
    try {
      s.store.create("run-1");
      const now = new Date("2026-08-28T12:00:00.000Z");
      await requestApproval(deps(s.store, { now: () => now, timeoutMs: 60_000 }), "run-1", req("rv-1"));

      const ext = s.store.get("run-1").extensions?.approval;
      expect(ext?.reportId).toBe("rv-1");
      expect(ext?.headSha).toBe(SHA_A);
      expect(ext?.expiresAt).toBe("2026-08-28T12:01:00.000Z");
      expect(ext?.supersededReportIds).toEqual([]);
    } finally {
      s.cleanup();
    }
  });

  test("a timeout under the 60s floor is clamped, never honoured as written", async () => {
    const s = store();
    try {
      s.store.create("run-1");
      const now = new Date("2026-08-28T12:00:00.000Z");
      await requestApproval(deps(s.store, { now: () => now, timeoutMs: 1 }), "run-1", req("rv-1"));
      const expiresAt = String(s.store.get("run-1").extensions?.approval?.expiresAt);
      expect(Date.parse(expiresAt) - now.getTime()).toBe(MIN_TIMEOUT_MS);
    } finally {
      s.cleanup();
    }
  });

  test.each([
    // The floor EXACTLY: clamping is `Math.max(ms, MIN)`, so the boundary value
    // must pass through unchanged — an off-by-one `>` here would raise a legal
    // policy timeout to the floor it was meant to sit at.
    ["the floor itself", MIN_TIMEOUT_MS],
    // An ordinary in-range value: the other clamp tests only ever visit the
    // floor, the ceiling and the non-finite fallback, so a clamp-everything
    // regression would pass every one of them. This is the arm that reds.
    ["an ordinary in-range value", 90_000],
    ["the ceiling itself", MAX_TIMEOUT_MS],
  ])("a timeout of %s (%p ms) is HONOURED as written", async (_name, ms) => {
    const s = store();
    try {
      s.store.create("run-1");
      const now = new Date("2026-08-28T12:00:00.000Z");
      await requestApproval(deps(s.store, { now: () => now, timeoutMs: ms }), "run-1", req("rv-1"));
      const expiresAt = String(s.store.get("run-1").extensions?.approval?.expiresAt);
      expect(Date.parse(expiresAt) - now.getTime()).toBe(ms);
    } finally {
      s.cleanup();
    }
  });

  test("a timeout ONE ms above the ceiling is clamped to exactly MAX_TIMEOUT_MS (T1)", async () => {
    // The boundary the clamp has to move: the absurd 9e15 case in the timeouts
    // describe only proves SOME upper bound exists, and a `Math.min` that lost
    // its ceiling (or a stale constant) would still pass it. MAX + 1 is the
    // smallest value that must come back changed.
    const s = store();
    try {
      s.store.create("run-1");
      const now = new Date("2026-08-28T12:00:00.000Z");
      await requestApproval(deps(s.store, { now: () => now, timeoutMs: MAX_TIMEOUT_MS + 1 }), "run-1", req("rv-1"));
      const expiresAt = String(s.store.get("run-1").extensions?.approval?.expiresAt);
      expect(Date.parse(expiresAt) - now.getTime()).toBe(MAX_TIMEOUT_MS);
    } finally {
      s.cleanup();
    }
  });
});

describe("AC1 — headSha and reportId are required, not defaulted", () => {
  test.each([
    ["a missing reportId", { proposal: "p", reportId: "", headSha: SHA_A }, /reportId/],
    ["a missing headSha", { proposal: "p", reportId: "rv-1", headSha: "" }, /headSha/],
    ["a short headSha", { proposal: "p", reportId: "rv-1", headSha: "abc" }, /headSha/],
    ["a 41-char headSha", { proposal: "p", reportId: "rv-1", headSha: "a".repeat(41) }, /headSha/],
    ["a non-hex headSha", { proposal: "p", reportId: "rv-1", headSha: "g".repeat(40) }, /headSha/],
  ])("%s is a schema rejection that registers NO namespace", async (_name, bad, expected) => {
    const s = store();
    try {
      s.store.create("run-1");
      // Which half the message names is pinned PER FIXTURE ROW — a row's own
      // field, not its display label — so a label edit cannot silently flip
      // which diagnostic a broken implementation is forgiven.
      await expect(requestApproval(deps(s.store), "run-1", bad)).rejects.toThrow(expected);
      expect(s.store.get("run-1").extensions?.approval).toBeUndefined();
    } finally {
      s.cleanup();
    }
  });

  test("an uppercase headSha is the SAME commit — normalized and bound, not rejected", async () => {
    const s = store();
    try {
      s.store.create("run-1");
      const upper = SHA_A.toUpperCase();
      const out = await requestApproval(deps(s.store), "run-1", req("rv-1", upper));
      expect(out.outcome).toBe("requested");
      // Stored lower-case: every later comparison (DF5.2's push-side recheck)
      // reads the record's own field, so the record is the one normal form.
      expect(s.store.get("run-1").extensions?.approval?.headSha).toBe(SHA_A);
    } finally {
      s.cleanup();
    }
  });

  test("HEAD_SHA_RE accepts a real 40-hex sha and nothing longer or shorter", () => {
    expect(HEAD_SHA_RE.test(SHA_A)).toBe(true);
    expect(HEAD_SHA_RE.test("0123456789abcdef0123456789abcdef01234567")).toBe(true);
    expect(HEAD_SHA_RE.test("a".repeat(39))).toBe(false);
    expect(HEAD_SHA_RE.test(`${SHA_A}0`)).toBe(false);
    expect(HEAD_SHA_RE.test("g".repeat(40))).toBe(false);
  });
});

describe("AC1(a2) — re-entry: rebind, refuse, or leave alone", () => {
  test("awaiting-approval REBINDS and APPENDS the displaced id, oldest-first", async () => {
    const s = store();
    try {
      s.store.create("run-1");
      const d = deps(s.store);
      await requestApproval(d, "run-1", req("rv-1", SHA_A));
      const second = await requestApproval(d, "run-1", req("rv-2", SHA_B));
      const third = await requestApproval(d, "run-1", req("rv-3", SHA_A));

      expect(second).toEqual({ outcome: "rebound", supersededReportId: "rv-1" });
      expect(third).toEqual({ outcome: "rebound", supersededReportId: "rv-2" });
      const ext = s.store.get("run-1").extensions?.approval;
      expect(ext?.reportId).toBe("rv-3");
      expect(ext?.supersededReportIds).toEqual(["rv-1", "rv-2"]);
      expect(ext?.state).toBe("awaiting-approval");
    } finally {
      s.cleanup();
    }
  });

  test("a rebind does NOT tear down again — the box died at the first pause", async () => {
    const s = store();
    try {
      s.store.create("run-1");
      const log: string[] = [];
      const d = deps(s.store, { teardown: recordingTeardown(s.store, log) });
      await requestApproval(d, "run-1", req("rv-1"));
      await requestApproval(d, "run-1", req("rv-2", SHA_B));
      expect(log).toEqual(["teardown:run-1:pausing"]);
    } finally {
      s.cleanup();
    }
  });

  test("a pausing record bound to THIS report is RESUMED: teardown re-runs, then it promotes", async () => {
    const s = store();
    try {
      s.store.create("run-1");
      // The record a crash between (a) and (c) leaves behind — with the
      // timestamps production stamped at registration, here long PAST: the
      // ordinary resume discovers a crashed pause after its original window
      // has already closed. Before AC1(c) was implemented nothing anywhere
      // promoted out of `pausing` — `expiredState` never expires it and
      // `submitDecision` calls it not-decidable — so this run was stranded
      // until somebody hand-edited the JSON.
      seedPausing(s.store, "run-1", "rv-1", { expiresAt: "2026-08-28T12:01:00.000Z" });
      const now = new Date("2026-08-30T12:00:00.000Z");
      const log: string[] = [];
      const out = await requestApproval(
        deps(s.store, { teardown: recordingTeardown(s.store, log), now: () => now }),
        "run-1",
        req("rv-1"),
      );

      expect(out).toEqual({ outcome: "requested" });
      // Teardown RE-RAN (idempotent under DF2.5) and still observed `pausing` —
      // the resume never promotes ahead of the box being destroyed.
      expect(log).toEqual(["teardown:run-1:pausing"]);
      const ext = s.store.get("run-1").extensions?.approval;
      expect(ext?.state).toBe("awaiting-approval");
      // The binding is the one already on disk, not a rebind.
      expect(ext?.reportId).toBe("rv-1");
      // T4: no `?? []`. A resume must LEAVE the history it found, so an absent
      // field has to fail here — the coalesced form reads a resume that reset
      // `supersededReportIds` to undefined as if it had preserved an empty one,
      // which is exactly the audit-trail loss the field exists to prevent.
      expect(ext?.supersededReportIds).toEqual([]);
      // …and the window is RESTAMPED before promotion, BOTH fields together:
      // promoting with the original (long-past) `expiresAt` would produce an
      // `awaiting-approval` record that is instantly `timed-out` on the first
      // read — against a run that was never awaiting anybody.
      expect(ext?.requestedAt).toBe(now.toISOString());
      expect(ext?.expiresAt).toBe(new Date(now.getTime() + DEFAULT_TIMEOUT_MS).toISOString());
    } finally {
      s.cleanup();
    }
  });

  test("a pausing record bound to a DIFFERENT report is a collision, not a resume", async () => {
    const s = store();
    try {
      s.store.create("run-1");
      seedPausing(s.store, "run-1", "rv-0", { expiresAt: "2026-08-29T12:00:00.000Z" });
      const before = fs.readFileSync(s.store.path("run-1"), "utf8");
      const log: string[] = [];
      const out = await requestApproval(deps(s.store, { teardown: recordingTeardown(s.store, log) }), "run-1", req("rv-9"));

      // Resuming here would rebind a record whose box may still be alive.
      expect(out).toEqual({ outcome: "pause-in-progress" });
      expect(log).toEqual([]);
      expect(fs.readFileSync(s.store.path("run-1"), "utf8")).toBe(before);
      // T12: and no residue. A collision answers from the state read alone — it
      // takes no seam, runs no teardown, and should leave neither an approval
      // lock nor a teardown claim behind it.
      expect(
        fs
          .readdirSync(s.dir)
          .filter((f) => f.includes(".approval.lock") || f.includes(".teardown.claim")),
      ).toEqual([]);
    } finally {
      s.cleanup();
    }
  });

  test("a DIFFERENT-report collision answers before the seam guard — no teardown wired is still no error", async () => {
    const s = store();
    try {
      s.store.create("run-1");
      seedPausing(s.store, "run-1", "rv-0", { expiresAt: "2026-08-29T12:00:00.000Z" });
      const before = fs.readFileSync(s.store.path("run-1"), "utf8");
      // NO teardown seam on an open record would refuse a fresh pause
      // (INV-APPROVE-6) — but a collision never reaches that guard, so the
      // answer is the same `pause-in-progress` the seam-wired call above
      // gives. This is the ordering pin: the cheap state read comes first.
      const out = await requestApproval(deps(s.store), "run-1", req("rv-9"));
      expect(out).toEqual({ outcome: "pause-in-progress" });
      expect(fs.readFileSync(s.store.path("run-1"), "utf8")).toBe(before);
    } finally {
      s.cleanup();
    }
  });

  test.each([["approved"], ["rejected"], ["timed-out"]])(
    "a rebind observing %s LOSES — the decided record is never resurrected",
    async (state) => {
      const s = store();
      try {
        s.store.create("run-1");
        s.store.set("run-1", {
          extensions: { approval: { state, proposal: "p", reportId: "rv-0", headSha: SHA_A } },
        });
        const before = fs.readFileSync(s.store.path("run-1"), "utf8");
        const out = await requestApproval(deps(s.store), "run-1", req("rv-9"));
        expect(out).toEqual({ outcome: "already-decided", state });
        expect(fs.readFileSync(s.store.path("run-1"), "utf8")).toBe(before);
      } finally {
        s.cleanup();
      }
    },
  );

  test("a rebind is refused when the run's harvested bundle is gone", async () => {
    const s = store();
    try {
      s.store.create("run-1");
      const bundles = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "qds-bundles-"));
      try {
        fs.writeFileSync(path.join(bundles, "run-1.bundle"), "pack");
        const d = deps(s.store, { bundleDir: bundles });
        await requestApproval(d, "run-1", req("rv-1"));
        fs.rmSync(path.join(bundles, "run-1.bundle"));
        const before = fs.readFileSync(s.store.path("run-1"), "utf8");
        await expect(requestApproval(d, "run-1", req("rv-2", SHA_B))).rejects.toThrow(/cannot rebind run-1/);
        // Refused ⇒ the binding is untouched — byte-identical, like every
        // other refusal in this describe.
        expect(s.store.get("run-1").extensions?.approval?.reportId).toBe("rv-1");
        expect(fs.readFileSync(s.store.path("run-1"), "utf8")).toBe(before);
      } finally {
        fs.rmSync(bundles, { recursive: true, force: true });
      }
    } finally {
      s.cleanup();
    }
  });

  test("a RESUME is refused when the run's harvested bundle is gone — all three routes to the decidable state are checked", async () => {
    const s = store();
    try {
      s.store.create("run-1");
      // The crashed-pause record a resume would promote, bound to the SAME
      // report the caller re-presents. Fresh-register and rebind both ran
      // `assertBundlePresent`; the resume was the third route and did not.
      seedPausing(s.store, "run-1", "rv-1", { expiresAt: "2026-08-28T12:01:00.000Z" });
      const before = fs.readFileSync(s.store.path("run-1"), "utf8");
      const bundles = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "qds-bundles-"));
      try {
        await expect(requestApproval(deps(s.store, { bundleDir: bundles }), "run-1", req("rv-1"))).rejects.toThrow(
          /bundle/,
        );
        // Refused ⇒ still `pausing`, byte-identical — recoverable, never
        // promoted over a bundle that no longer exists.
        expect(fs.readFileSync(s.store.path("run-1"), "utf8")).toBe(before);
      } finally {
        fs.rmSync(bundles, { recursive: true, force: true });
      }
    } finally {
      s.cleanup();
    }
  });

  test("CONCURRENT resumes of one pausing record never run teardown at the same time", async () => {
    const s = store();
    try {
      s.store.create("run-1");
      seedPausing(s.store, "run-1", "rv-1", { expiresAt: "2026-08-29T12:00:00.000Z" });
      // The approval lock is deliberately NOT held across teardown, so two
      // same-reportId resumes both reach `deps.teardown` — and its
      // `pullArtifacts` writes fixed shared host paths, which two concurrent
      // pulls race on. The teardown claim serializes them: re-running is
      // idempotent (DF2.5), OVERLAPPING is not.
      let inFlight = 0;
      let maxInFlight = 0;
      let ran = 0;
      // CLAIM EXISTENCE DURING the overlap, sampled from inside the teardown
      // itself: `maxInFlight === 1` alone passes even on an implementation
      // whose two teardowns never actually overlapped in time, and `ran >= 1`
      // passed one that never took a claim at all. Seeing the claim file under
      // a running teardown is direct evidence the fence was taken.
      let sawClaim = false;
      const claimPath = path.join(s.dir, "run-1.teardown.claim");
      const d = deps(s.store, {
        teardown: async () => {
          ran++;
          sawClaim = sawClaim || fs.existsSync(claimPath);
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await Bun.sleep(20);
          inFlight--;
        },
      });
      const outs = await Promise.all([requestApproval(d, "run-1", req("rv-1")), requestApproval(d, "run-1", req("rv-1"))]);

      expect(maxInFlight).toBe(1);
      expect(ran).toBeGreaterThanOrEqual(1);
      // The claim was real, not theoretical: some teardown observed the fence
      // file on disk while it ran.
      expect(sawClaim).toBe(true);
      expect(s.store.get("run-1").extensions?.approval?.state).toBe("awaiting-approval");
      // The loser of the transition race either resumes behind the winner
      // (`requested`), rebinds against the already-promoted record
      // (`rebound`), or loses the promote race itself and answers
      // `pause-in-progress` — the round-7 outcome fix: a call that skipped
      // its promotion must not claim `requested`. All three are non-error;
      // only the false `requested` was a lie.
      for (const out of outs) expect(["requested", "rebound", "pause-in-progress"]).toContain(out.outcome);
      // …and the claim file is released, not leaked to wedge the next resume.
      expect(fs.readdirSync(s.dir).filter((f) => f.includes(".teardown.claim"))).toEqual([]);
    } finally {
      s.cleanup();
    }
  });

  test("a teardown that THROWS releases its claim — the resume stays re-runnable", async () => {
    const s = store();
    try {
      s.store.create("run-1");
      // The crash AC1(c) exists for: the pause dies INSIDE teardown, while it
      // holds the claim. A claim leaked here would wedge every later resume
      // until its pid is provably dead — i.e. until this process exits.
      seedPausing(s.store, "run-1", "rv-1");
      await expect(
        requestApproval(
          deps(s.store, {
            teardown: async () => {
              throw new Error("box destroy failed");
            },
          }),
          "run-1",
          req("rv-1"),
        ),
      ).rejects.toThrow(/box destroy failed/);

      // The record still says `pausing` (the recoverable state), and the claim
      // is GONE, not left behind for the next resume to wait out.
      expect(s.store.get("run-1").extensions?.approval?.state).toBe("pausing");
      expect(fs.readdirSync(s.dir).filter((f) => f.includes(".teardown.claim"))).toEqual([]);
    } finally {
      s.cleanup();
    }
  });

  test("a crashed resume's STALE claim (dead pid, aged past LOCK_STALE_MS) is reclaimed, not waited on", async () => {
    const s = store();
    try {
      s.store.create("run-1");
      seedPausing(s.store, "run-1", "rv-1");
      // What a killed resume process leaves behind: a claim whose holder pid
      // can be proven dead. pid 2^31-1 is above every configured pid_max.
      // BACKDATED past the stale window — age is the precondition for even
      // LOOKING, so a fresh claim from a live writer is never inspected.
      const claim = path.join(s.dir, "run-1.teardown.claim");
      fs.writeFileSync(claim, "2147483647:crashed-teardown");
      const ancient = new Date(Date.now() - 60_000);
      fs.utimesSync(claim, ancient, ancient);

      // T11: proof of "rename-aside then `wx`", not inode arithmetic. Inode
      // *numbers* are not a reliable witness of a fresh file — Linux ext4
      // reuses a just-freed inode number immediately, so a dead holder's
      // inode can coincidentally match the reclaimer's new one even though
      // the reclaim genuinely renamed the stale claim aside, verified its
      // content, removed it, and re-created `claimPath` from scratch. Spy on
      // the actual syscalls instead: the property under test is the CALL
      // SEQUENCE (rename claimPath → a private `.reclaim.` path, THEN open
      // claimPath fresh with `wx`), which an in-place rewrite could never
      // produce — it would never rename claimPath away at all.
      // ONE shared, ORDERED log — a per-spy `.mock.calls` array cannot prove
      // the cross-call ORDER between rename and open, only each call's own
      // position among calls to that same function.
      const seq: Array<{ op: "rename" | "open"; from: string; to?: string; flags?: unknown }> = [];
      const realRenameSync = fs.renameSync;
      const realOpenSync = fs.openSync;
      const renameSpy = spyOn(fs, "renameSync").mockImplementation(((...args: Parameters<typeof fs.renameSync>) => {
        seq.push({ op: "rename", from: String(args[0]), to: String(args[1]) });
        return realRenameSync(...args);
      }) as typeof fs.renameSync);
      const openSpy = spyOn(fs, "openSync").mockImplementation(((...args: Parameters<typeof fs.openSync>) => {
        seq.push({ op: "open", from: String(args[0]), flags: args[1] });
        return realOpenSync(...args);
      }) as typeof fs.openSync);

      let teardownRuns = 0;
      const out = await requestApproval(
        deps(s.store, {
          teardown: async () => {
            teardownRuns++;
          },
        }),
        "run-1",
        req("rv-1"),
      );
      renameSpy.mockRestore();
      openSpy.mockRestore();

      // Reclaimed and re-taken by THIS resume: the teardown ran (a wedged
      // waiter would have spun past CLAIM_TIMEOUT_MS instead — five minutes),
      // the record promoted, and the recycled claim is gone.
      expect(out).toEqual({ outcome: "requested" });
      expect(teardownRuns).toBe(1);
      const renameIdx = seq.findIndex((e) => e.op === "rename" && e.from === claim && e.to?.includes(".teardown.claim.reclaim."));
      expect(renameIdx).toBeGreaterThanOrEqual(0);
      // The fresh open must come AFTER the steal-rename vacated claimPath —
      // otherwise a `wx` open that merely happened to run earlier (this
      // resume's own first, failed attempt) would look like proof of reclaim
      // without the reclaim sequence having actually run.
      const reopenIdx = seq.findIndex((e, i) => i > renameIdx && e.op === "open" && e.from === claim && e.flags === "wx");
      expect(reopenIdx).toBeGreaterThan(renameIdx);
      expect(s.store.get("run-1").extensions?.approval?.state).toBe("awaiting-approval");
      expect(fs.readdirSync(s.dir).filter((f) => f.includes(".teardown.claim"))).toEqual([]);
    } finally {
      s.cleanup();
    }
  });

  test("a restore FAULT while stealing a stale teardown claim poisons the vacant claim before failing", async () => {
    const s = store();
    try {
      s.store.create("run-1");
      seedPausing(s.store, "run-1", "rv-1");
      const claim = path.join(s.dir, "run-1.teardown.claim");
      fs.writeFileSync(claim, "2147483647:crashed-teardown");
      const ancient = new Date(Date.now() - 60_000);
      fs.utimesSync(claim, ancient, ancient);

      // Land the fault inside the steal: the rename captures a REPLACEMENT's
      // content (mismatch ⇒ the link-restore branch), and the link itself
      // fails with a non-EEXIST fault — the exact shape the poison exists
      // for. Without the marker the vacant claim path would let the next
      // resume's `wx` succeed and run teardown concurrently with the live
      // holder this capture displaced.
      const replacement = `${process.pid}:live-replacement`;
      const realRenameSync = fs.renameSync;
      const realLinkSync = fs.linkSync;
      const renameSpy = spyOn(fs, "renameSync").mockImplementation(((...args: Parameters<typeof fs.renameSync>) => {
        if (typeof args[0] === "string" && args[0] === claim && typeof args[1] === "string" && args[1].includes(".teardown.claim.reclaim.")) {
          // The live replacement lands in the steal window: the rename now
          // captures different content than the stale claim that was read.
          fs.rmSync(args[0], { force: true });
          fs.writeFileSync(args[0], replacement, { flag: "wx" });
        }
        return realRenameSync(...args);
      }) as typeof fs.renameSync);
      const linkSpy = spyOn(fs, "linkSync").mockImplementation(((...args: Parameters<typeof fs.linkSync>) => {
        if (typeof args[0] === "string" && args[0].includes(".teardown.claim.reclaim.")) throw new Error("simulated EIO");
        return realLinkSync(...args);
      }) as typeof fs.linkSync);

      let err: unknown;
      try {
        await requestApproval(deps(s.store, { teardown: async () => {} }), "run-1", req("rv-1"));
      } catch (e) {
        err = e;
      } finally {
        renameSpy.mockRestore();
        linkSpy.mockRestore();
      }

      // Failed LOUDLY, naming the recovery state — not a silent resume over a
      // vacant claim.
      expect((err as Error).message).toContain("failed to restore the captured claim");
      expect((err as Error).message).toContain("poison marker now holds");
      // The vacant claim path now holds a pid-0 marker the dead-pid door can
      // never reclaim, and the captured replacement's claim is preserved for
      // hand recovery.
      expect(fs.readFileSync(claim, "utf8")).toMatch(/^0:/);
      const leftovers = fs.readdirSync(s.dir).filter((f) => f.includes("run-1.teardown.claim.reclaim."));
      expect(leftovers).toHaveLength(1);
      expect(fs.readFileSync(path.join(s.dir, leftovers[0]!), "utf8")).toBe(replacement);
    } finally {
      s.cleanup();
    }
  });

  test("a restore FAULT while stealing a stale approval lock poisons the vacant lock before failing", async () => {
    const s = store();
    try {
      s.store.create("run-1");
      const lock = path.join(s.dir, "run-1.approval.lock");
      fs.writeFileSync(lock, "2147483647:dead-holder");
      const ancient = new Date(Date.now() - 60_000);
      fs.utimesSync(lock, ancient, ancient);

      // The withApprovalLock twin of the fault above: the acquire loop's
      // stale reclaim captures a replacement's content, and the link-restore
      // faults non-EEXIST. The vacant lockPath must be poisoned before the
      // error surfaces, or the next acquirer's `wx` succeeds and enters
      // `body()` alongside the live replacement holder.
      const replacement = `${process.pid}:live-replacement`;
      const realRenameSync = fs.renameSync;
      const realLinkSync = fs.linkSync;
      const renameSpy = spyOn(fs, "renameSync").mockImplementation(((...args: Parameters<typeof fs.renameSync>) => {
        if (typeof args[0] === "string" && args[0] === lock && typeof args[1] === "string" && args[1].includes(".approval.lock.claim.")) {
          fs.rmSync(args[0], { force: true });
          fs.writeFileSync(args[0], replacement, { flag: "wx" });
        }
        return realRenameSync(...args);
      }) as typeof fs.renameSync);
      const linkSpy = spyOn(fs, "linkSync").mockImplementation(((...args: Parameters<typeof fs.linkSync>) => {
        if (typeof args[0] === "string" && args[0].includes(".approval.lock.claim.")) throw new Error("simulated EIO");
        return realLinkSync(...args);
      }) as typeof fs.linkSync);

      let err: unknown;
      try {
        await withApprovalLock(s.dir, "run-1", async () => "irrelevant — never reached");
      } catch (e) {
        err = e;
      } finally {
        renameSpy.mockRestore();
        linkSpy.mockRestore();
      }

      expect((err as Error).message).toContain("failed to restore replacement lock");
      expect((err as Error).message).toContain("poison marker now holds");
      expect(fs.readFileSync(lock, "utf8")).toMatch(/^0:/);
      const leftovers = fs.readdirSync(s.dir).filter((f) => f.includes("run-1.approval.lock.claim."));
      expect(leftovers).toHaveLength(1);
      expect(fs.readFileSync(path.join(s.dir, leftovers[0]!), "utf8")).toBe(replacement);
    } finally {
      s.cleanup();
    }
  });

  test("the restore-fault poison marker is NEVER stale-reclaimed — the resume fails at the deadline, teardown never runs", async () => {
    const s = store();
    try {
      s.store.create("run-1");
      seedPausing(s.store, "run-1", "rv-1");
      const claim = path.join(s.dir, "run-1.teardown.claim");
      // The exact artifact the restore-fault arm leaves: pid-less, non-empty.
      fs.writeFileSync(claim, "0:restore-fault-marker");

      // REGRESSION (CodeRabbit round-9 re-review): the claim door used to read
      // a missing pid as "no holder" and sweep ANY stale content, so this
      // marker was renamed away and deleted LOCK_STALE_MS after the fault —
      // reopening the concurrent-teardown race the marker exists to end. The
      // door now takes a pid-less claim only when its content is EMPTY (the
      // stranded zero-byte shape), so the marker holds past the stale window
      // and the waiter surfaces the deadline error instead.
      //
      // Constants are module-private; these mirror LOCK_STALE_MS (2× the 5 s
      // LOCK_TIMEOUT_MS) and CLAIM_TIMEOUT_MS. The FAKE clock walks both
      // windows so the test pays a few real poll sleeps, not five minutes.
      const LOCK_STALE_MS = 10_000;
      const CLAIM_TIMEOUT_MS = 300_000;
      const base = Date.now();
      setSystemTime(new Date(base + LOCK_STALE_MS + 1_000));
      let teardownRuns = 0;
      const p = requestApproval(
        deps(s.store, {
          teardown: async () => {
            teardownRuns++;
          },
        }),
        "run-1",
        req("rv-1"),
      );
      await Bun.sleep(120); // the waiter looks at the marker, refuses it, waits
      setSystemTime(new Date(base + LOCK_STALE_MS + 1_000 + CLAIM_TIMEOUT_MS + 1_000));

      let msg = "";
      try {
        await p;
      } catch (e) {
        msg = (e as Error).message;
      }
      expect(msg).toContain("still held after");
      expect(msg).toContain("poison marker");
      expect(teardownRuns).toBe(0);
      expect(fs.readFileSync(claim, "utf8")).toBe("0:restore-fault-marker");
    } finally {
      setSystemTime(); // restore the real clock for every other test
      s.cleanup();
    }
  });

  test("a zero-byte stale claim (a crash between the wx and the content write) is STILL reclaimed", async () => {
    const s = store();
    try {
      s.store.create("run-1");
      seedPausing(s.store, "run-1", "rv-1");
      const claim = path.join(s.dir, "run-1.teardown.claim");
      // The stranded shape the pid-less door must KEEP reclaiming: empty
      // content names no holder that could be alive, and no writer is coming —
      // the crash that stranded it already happened.
      fs.writeFileSync(claim, "");
      const ancient = new Date(Date.now() - 60_000);
      fs.utimesSync(claim, ancient, ancient);

      let teardownRuns = 0;
      const out = await requestApproval(
        deps(s.store, {
          teardown: async () => {
            teardownRuns++;
          },
        }),
        "run-1",
        req("rv-1"),
      );
      expect(out).toEqual({ outcome: "requested" });
      expect(teardownRuns).toBe(1);
      expect(fs.readdirSync(s.dir).filter((f) => f.includes(".teardown.claim"))).toEqual([]);
    } finally {
      s.cleanup();
    }
  });

  test("a FRESH claim held by this process is WAITED on, never stolen — then taken once free", async () => {
    const s = store();
    try {
      s.store.create("run-1");
      seedPausing(s.store, "run-1", "rv-1");
      // A live holder's claim, un-backdated: age below LOCK_STALE_MS means the
      // waiter may not even READ it, however dead its pid looks. Stealing here
      // is the pullArtifacts race the claim exists to prevent. The holder is
      // released mid-wait, and the waiter must then proceed.
      const claim = path.join(s.dir, "run-1.teardown.claim");
      fs.writeFileSync(claim, "2147483647:mid-write-holder");
      let teardownRan = false;
      const t0 = Date.now();
      // T3: WHEN the waiter settled, recorded by the waiter itself. A bound
      // taken AFTER the release can never fail (this test's own sleeps dominate
      // it); the load-bearing question is whether the waiter settled BEFORE the
      // release that permitted it.
      let settledAt = Number.POSITIVE_INFINITY;
      const p = requestApproval(
        deps(s.store, {
          teardown: async () => {
            teardownRan = true;
          },
        }),
        "run-1",
        req("rv-1"),
      ).then((v) => {
        settledAt = Date.now();
        return v;
      });
      await Bun.sleep(120); // far past the 10ms poll; the claim is being waited on
      // THE CRITICAL MOMENT, asserted before the holder is released. Every
      // check below is one a claim-STEALING implementation fails: it would
      // have deleted the claim, run teardown and promoted inside this window,
      // which is exactly the concurrency the fence exists to prevent.
      // T2: the parking PROOF, not just the state — the transition approval lock
      // is released before the claim is taken, so its absence together with the
      // claim's presence is what distinguishes "parked on the claim" from
      // "has not reached the lock yet" (every line below is also true of that).
      expect(fs.existsSync(path.join(s.dir, "run-1.approval.lock"))).toBe(false);
      expect(fs.existsSync(claim)).toBe(true);
      expect(fs.readFileSync(claim, "utf8")).toBe("2147483647:mid-write-holder");
      expect(teardownRan).toBe(false);
      expect(s.store.get("run-1").extensions?.approval?.state).toBe("pausing");
      const tRelease = Date.now();
      fs.rmSync(claim, { force: true }); // the holder finishes and its claim goes away
      expect(await p).toEqual({ outcome: "requested" });
      // T3, the bound that can fail: a waiter that ignored or stole the claim
      // settled DURING the hold, so its timestamp precedes the release. Only a
      // waiter that respected the fence settles after it.
      expect(settledAt).toBeGreaterThanOrEqual(tRelease);
      expect(settledAt).toBeLessThan(t0 + 30_000); // …and promptly, not at a timeout
      expect(s.store.get("run-1").extensions?.approval?.state).toBe("awaiting-approval");
    } finally {
      s.cleanup();
    }
  });

  test("a STALE claim whose holder pid is ALIVE is not reclaimed — age alone never reclaims", async () => {
    const s = store();
    try {
      s.store.create("run-1");
      seedPausing(s.store, "run-1", "rv-1");
      // The DISCRIMINATOR for the reclaim door: the stale-claim test above
      // proves an aged DEAD-pid claim is reclaimed, but an implementation that
      // deletes any aged claim file without checking liveness passes it. This
      // one is aged past LOCK_STALE_MS yet its holder pid still resolves, so
      // only a liveness-gated reclaim leaves it standing while this process
      // waits.
      const claim = path.join(s.dir, "run-1.teardown.claim");
      fs.writeFileSync(claim, `${process.pid}:alive-but-aged`);
      const ancient = new Date(Date.now() - 60_000);
      fs.utimesSync(claim, ancient, ancient);

      let teardownRan = false;
      const t0 = Date.now();
      // T3: WHEN the waiter settled (see the fresh-claim test above — the bound
      // that can fail is the one taken against the release, not after it).
      let settledAt = Number.POSITIVE_INFINITY;
      const p = requestApproval(
        deps(s.store, {
          teardown: async () => {
            teardownRan = true;
          },
        }),
        "run-1",
        req("rv-1"),
      ).then((v) => {
        settledAt = Date.now();
        return v;
      });
      await Bun.sleep(120); // far past the 10ms poll; a stealer has acted by now
      // Not stolen, not replaced, and no teardown behind the steal: the aged
      // claim named a LIVE holder, so it stays exactly as written.
      // T2: the parking proof — the transition lock is gone, the claim is not.
      expect(fs.existsSync(path.join(s.dir, "run-1.approval.lock"))).toBe(false);
      expect(fs.existsSync(claim)).toBe(true);
      expect(fs.readFileSync(claim, "utf8")).toBe(`${process.pid}:alive-but-aged`);
      expect(teardownRan).toBe(false);
      expect(s.store.get("run-1").extensions?.approval?.state).toBe("pausing");
      // The holder finishes; the waiter must then take over and complete.
      const tRelease = Date.now();
      fs.rmSync(claim, { force: true });
      expect(await p).toEqual({ outcome: "requested" });
      // T3: a liveness-blind stealer settled before this release; a correct
      // waiter could not have.
      expect(settledAt).toBeGreaterThanOrEqual(tRelease);
      expect(settledAt).toBeLessThan(t0 + 30_000);
      expect(s.store.get("run-1").extensions?.approval?.state).toBe("awaiting-approval");
    } finally {
      s.cleanup();
    }
  });

  test("a holder suspended between its claim `wx` and its content write does NOT tear down first (G5)", async () => {
    // G1's twin on the teardown claim. A claim is taken open-then-write, and the
    // re-verify through the PATH between the two is what stops a holder
    // suspended for longer than LOCK_STALE_MS from tearing down beside the
    // waiter that reclaimed its empty claim. There is no seam at which a test
    // can suspend a holder, so the suspension is simulated exactly where it
    // happens: the claim's CONTENT write is intercepted, and a real second
    // resume runs inside that window.
    const s = store();
    let openSpy: { mockRestore(): void } | undefined;
    let writeSpy: { mockRestore(): void } | undefined;
    // Outer scope, so the finally can drain the waiter it may have started: a
    // resume left mid-wait here wakes into whatever directory the NEXT test
    // just created, and its writes then land in that test's spies.
    let second: Promise<unknown> | undefined;
    try {
      s.store.create("run-1");
      seedPausing(s.store, "run-1", "rv-1");
      const claimPath = path.join(s.dir, "run-1.teardown.claim");
      const order: string[] = [];
      let inFlight = 0;
      let maxInFlight = 0;
      // Guards on the simulation itself: the intercepted write must be the
      // CLAIM's (an empty claim on the path, the approval lock already
      // released), or everything below is pinned to the wrong call site.
      let sawEmptyClaim = false;
      let armed = false;
      const realOpenSync = fs.openSync;
      const realWriteFileSync = fs.writeFileSync;
      openSpy = spyOn(fs, "openSync").mockImplementation(((p, flags, mode) => {
        // The suspended holder's RETRY after its loss, stopped with a non-EEXIST
        // fault: a real holder is a dead process by now, and an un-armed retry
        // would take the claim back and tear down a second time — legal, but not
        // what this test is about. The holder's retry is the FIRST claim-path
        // open after the interception (everything it does between the two is
        // synchronous), so arming at the interception and disarming on the first
        // hit cannot reach the second resume's later attempts.
        if (armed && p === claimPath) {
          armed = false;
          const stop = new Error("test: suspended holder stopped") as NodeJS.ErrnoException;
          stop.code = "EACCES";
          throw stop;
        }
        return realOpenSync(p, flags, mode);
      }) as typeof fs.openSync);
      writeSpy = spyOn(fs, "writeFileSync").mockImplementation(((target, data, opts) => {
        // The claim's content write is identified by the filesystem, not by
        // call order: the store's own record writes are fd-targeted too, so the
        // intercept is the first fd write that happens with an EMPTY claim
        // already on the path — exactly the state a `wx` with no content yet
        // leaves.
        if (typeof target === "number" && !sawEmptyClaim && fs.existsSync(claimPath) && fs.statSync(claimPath).size === 0) {
          sawEmptyClaim = true;
          // The suspension outlasted LOCK_STALE_MS: backdate the empty claim the
          // `wx` left behind, then reclaim it the way a waiter's door does —
          // rename aside, prove the captured bytes are still the empty content
          // that was judged, remove. (`withTeardownClaim` is module-private, so
          // the reclaim cannot be driven by calling the waiter directly: a
          // second resume's synchronous prefix stops at its own transition lock
          // and never reaches the claim.)
          const ancient = new Date(Date.now() - 60_000);
          fs.utimesSync(claimPath, ancient, ancient);
          const stealPath = `${claimPath}.reclaim.${process.pid}.test`;
          fs.renameSync(claimPath, stealPath);
          expect(fs.readFileSync(stealPath, "utf8")).toBe("");
          fs.rmSync(stealPath, { force: true });
          // THEN start the real second resume: it finds the path vacant, takes
          // the claim and tears down, while this holder is suspended with an fd
          // that now names an unlinked inode.
          armed = true;
          second = requestApproval(
            deps(s.store, {
              teardown: async () => {
                order.push("waiter");
                inFlight++;
                maxInFlight = Math.max(maxInFlight, inFlight);
                await Bun.sleep(20);
                inFlight--;
              },
            }),
            "run-1",
            req("rv-1"),
          );
          return; // deliberately no content
        }
        return realWriteFileSync(target, data, opts);
      }) as typeof fs.writeFileSync);

      let holderErr: unknown;
      try {
        await requestApproval(
          deps(s.store, {
            teardown: async () => {
              order.push("holder");
              inFlight++;
              maxInFlight = Math.max(maxInFlight, inFlight);
              await Bun.sleep(20);
              inFlight--;
            },
          }),
          "run-1",
          req("rv-1"),
        );
      } catch (e) {
        holderErr = e;
      }

      // The simulation landed where it meant to, and the suspended holder lost
      // its claim to the waiter rather than entering its body.
      expect(sawEmptyClaim).toBe(true);
      expect(holderErr).toBeDefined();
      // THE pin: the suspended holder never tore down — a deleted re-verify
      // breaks out of the loop on its own (now unlinked) inode and runs
      // teardown FIRST, before the waiter that reclaimed the claim.
      expect(order).toEqual(["waiter"]);
      expect(maxInFlight).toBe(1);
      await expect(second).resolves.toEqual({ outcome: "requested" });
      expect(s.store.get("run-1").extensions?.approval?.state).toBe("awaiting-approval");
      expect(fs.readdirSync(s.dir).filter((f) => f.includes(".teardown.claim"))).toEqual([]);
    } finally {
      openSpy?.mockRestore();
      writeSpy?.mockRestore();
      // The second resume may still be mid-wait if an assertion above failed;
      // drain it so it never wakes inside a directory this test has removed.
      await second?.catch(() => {});
      s.cleanup();
    }
  });
});

describe("AC2 — submitDecision: first decision wins", () => {
  const seed = async (s: RunRecordStore) => {
    s.create("run-1");
    await requestApproval(deps(s), "run-1", req("rv-1"));
  };

  test("an approve closes the record with approverId, decidedAt and reason", async () => {
    const s = store();
    try {
      await seed(s.store);
      const t0 = Date.now() - 1;
      const out = await submitDecision(deps(s.store), "run-1", {
        decision: "approved",
        approverId: "alice",
        reason: "looks right",
        reportId: "rv-1",
      });
      expect(out.outcome).toBe("decided");
      const ext = s.store.get("run-1").extensions?.approval;
      expect(ext?.state).toBe("approved");
      expect(ext?.approverId).toBe("alice");
      expect(ext?.reason).toBe("looks right");
      // T6: BOUNDED, not merely shaped. /^\d{4}-/T/ is satisfied by any date in
      // the file's history — including a stamp a bad merge carried over — so
      // the pin is that `decidedAt` is THIS decision's instant, inside the
      // window this test measured around the call.
      const decidedMs = Date.parse(String(ext?.decidedAt));
      expect(Number.isFinite(decidedMs)).toBe(true);
      expect(decidedMs).toBeGreaterThanOrEqual(t0);
      expect(decidedMs).toBeLessThanOrEqual(Date.now());
      // DF5.2 refuses `approval-incomplete` without BOTH, and
      // `approval-precedes-report` on a stamp older than the report.
    } finally {
      s.cleanup();
    }
  });

  test("a DUPLICATE approve returns the FIRST decision with no state change", async () => {
    const s = store();
    try {
      await seed(s.store);
      const d = deps(s.store);
      await submitDecision(d, "run-1", { decision: "approved", approverId: "alice", reason: "first", reportId: "rv-1" });
      const before = fs.readFileSync(s.store.path("run-1"), "utf8");
      const out = await submitDecision(d, "run-1", { decision: "approved", approverId: "bob", reason: "second", reportId: "rv-1" });

      // A last-write-wins implementation satisfies the happy path above and
      // MUST fail here: it would answer "decided" and stamp bob.
      expect(out).toMatchObject({ outcome: "already-decided", state: "approved", approverId: "alice", reason: "first" });
      expect(fs.readFileSync(s.store.path("run-1"), "utf8")).toBe(before);
    } finally {
      s.cleanup();
    }
  });

  test("a CONTRADICTING reject after an approve returns the approve, unchanged", async () => {
    const s = store();
    try {
      await seed(s.store);
      const d = deps(s.store);
      await submitDecision(d, "run-1", { decision: "approved", approverId: "alice", reason: "yes", reportId: "rv-1" });
      const before = fs.readFileSync(s.store.path("run-1"), "utf8");
      const out = await submitDecision(d, "run-1", { decision: "rejected", approverId: "mallory", reason: "no", reportId: "rv-1" });

      expect(out).toMatchObject({ outcome: "already-decided", state: "approved", approverId: "alice" });
      expect(fs.readFileSync(s.store.path("run-1"), "utf8")).toBe(before);
    } finally {
      s.cleanup();
    }
  });

  test("an APPROVE after a REJECT loses the same way — first wins in BOTH directions", async () => {
    const s = store();
    try {
      await seed(s.store);
      const d = deps(s.store);
      await submitDecision(d, "run-1", { decision: "rejected", approverId: "alice", reason: "no", reportId: "rv-1" });
      const out = await submitDecision(d, "run-1", { decision: "approved", approverId: "mallory", reason: "overruled", reportId: "rv-1" });

      // The mirror of the case above, and not redundant: a last-write-wins
      // implementation that special-cased "an approve always wins" would pass
      // the approve-first test and fail this one.
      expect(out).toMatchObject({ outcome: "already-decided", state: "rejected", approverId: "alice" });
      expect(s.store.get("run-1").extensions?.approval?.state).toBe("rejected");
    } finally {
      s.cleanup();
    }
  });

  test("CONCURRENT decisions serialize — exactly one is recorded", async () => {
    const s = store();
    try {
      await seed(s.store);
      const d = deps(s.store);
      const outs = await Promise.all([
        submitDecision(d, "run-1", { decision: "approved", approverId: "alice", reason: "a", reportId: "rv-1" }),
        submitDecision(d, "run-1", { decision: "rejected", approverId: "bob", reason: "b", reportId: "rv-1" }),
      ]);
      expect(outs.map((o) => o.outcome).sort()).toEqual(["already-decided", "decided"]);
      const ext = s.store.get("run-1").extensions?.approval;
      expect(["alice", "bob"]).toContain(String(ext?.approverId));
      // Whoever lost sees the winner's decision, not their own.
      const loser = outs.find((o) => o.outcome === "already-decided");
      expect(loser).toMatchObject({ approverId: String(ext?.approverId), state: String(ext?.state) });
    } finally {
      s.cleanup();
    }
  });

  test("CONCURRENT decisions serialize ACROSS PROCESSES — exactly one is recorded", async () => {
    // The test above is in-process, where `submitDecision`'s critical section
    // is synchronous and the two calls CANNOT interleave — it pins the
    // compare-and-set, not the lock. The rebind test at the bottom of this file
    // makes the same point for `pauseRun`; this is the decide-side twin: two
    // real processes, one real lock, one terminal record.
    const s = store();
    const children: ReturnType<typeof Bun.spawn>[] = [];
    try {
      await seed(s.store);
      const child = (approver: string) =>
        Bun.spawn(
          [
            "bun",
            "-e",
            `const { submitDecision } = await import(${JSON.stringify(path.join(REPO_SRC, "fleet", "approval-gate.ts"))});
             const { RunRecordStore } = await import(${JSON.stringify(path.join(REPO_SRC, "providers", "run-record.ts"))});
             const store = new RunRecordStore({ dir: ${JSON.stringify(s.dir)} });
             const out = await submitDecision({ store }, "run-1", { decision: "approved", approverId: ${JSON.stringify(approver)}, reason: "r", reportId: "rv-1" });
             console.log(JSON.stringify(out));`,
          ],
          { stdout: "pipe", stderr: "pipe" },
        );
      children.push(child("alice"), child("bob"));
      const outs = await Promise.all(
        children.map(async (c) => new Response(c.stdout as never).text()),
      );
      // Diagnose BEFORE asserting on `parsed`: a child that failed to import or
      // crashed produces too few lines with a cause that only its stderr and
      // exit code still hold. Drained (not discarded) so a wedge is impossible.
      const errs = await Promise.all(children.map((c) => new Response(c.stderr as never).text()));
      const codes = await Promise.all(children.map((c) => c.exited));
      expect(codes).toEqual([0, 0]);
      expect(errs.join("")).toBe("");

      // Exactly one `decided`; the loser answers `already-decided` with the
      // winner's decision — never two `decided` lines for one run.
      const parsed = outs.flatMap((t) =>
        t
          .split("\n")
          .filter((l) => l.startsWith('{"outcome"'))
          .map((l) => JSON.parse(l) as { outcome: string; approverId: string; state: string }),
      );
      expect(parsed).toHaveLength(2);
      expect(parsed.map((o) => o.outcome).sort()).toEqual(["already-decided", "decided"]);
      const winner = parsed.find((o) => o.outcome === "decided");
      expect(winner?.approverId === "alice" || winner?.approverId === "bob").toBe(true);
      // …and the RECORD agrees, with exactly one approver on it.
      const ext = s.store.get("run-1").extensions?.approval;
      expect(ext?.state).toBe(winner?.state);
      expect(String(ext?.approverId)).toBe(String(winner?.approverId));
      expect(ext?.approverId === "alice" || ext?.approverId === "bob").toBe(true);
    } finally {
      for (const c of children) c.kill();
      // T18: the children are dead BEFORE their runs directory is removed — a
      // child still holding an open fd (or still polling) under a deleted dir
      // turns a cleanup into a cross-test race.
      await Promise.all(children.map((c) => c.exited));
      s.cleanup();
    }
  }, 60_000);

  test("a decision is refused when the harvested bundle is gone — the decide side of the bundle invariant", async () => {
    const s = store();
    try {
      // The other two `assertBundlePresent` call sites (pause, rebind, resume)
      // are pinned above; this is the one round 7 added and nothing tested:
      // an approver authorizing a PR from a bundle that no longer exists is
      // refused at the last moment it can be.
      const bundles = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "qds-bundles-"));
      try {
        s.store.create("run-1");
        const d = deps(s.store, { bundleDir: bundles });
        // Present for the pause (the pause route checks too), then gone.
        fs.writeFileSync(path.join(bundles, "run-1.bundle"), "pack");
        await requestApproval(d, "run-1", req("rv-1"));
        fs.rmSync(path.join(bundles, "run-1.bundle"));
        const before = fs.readFileSync(s.store.path("run-1"), "utf8");
        await expect(
          submitDecision(d, "run-1", { decision: "approved", approverId: "alice", reason: "r", reportId: "rv-1" }),
        ).rejects.toThrow(/cannot decide run-1/);
        // Refused ⇒ still awaiting, byte-identical — like every other refusal.
        expect(s.store.get("run-1").extensions?.approval?.state).toBe("awaiting-approval");
        expect(fs.readFileSync(s.store.path("run-1"), "utf8")).toBe(before);
      } finally {
        fs.rmSync(bundles, { recursive: true, force: true });
      }
    } finally {
      s.cleanup();
    }
  });

  test("a decision against a SUPERSEDED reportId is refused and names the current one", async () => {
    const s = store();
    try {
      await seed(s.store);
      const d = deps(s.store);
      await requestApproval(d, "run-1", req("rv-2", SHA_B)); // rebind under the approver's feet
      const before = fs.readFileSync(s.store.path("run-1"), "utf8");
      const out = await submitDecision(d, "run-1", { decision: "approved", approverId: "alice", reason: "stale", reportId: "rv-1" });

      expect(out).toEqual({ outcome: "report-changed", reportId: "rv-2" });
      expect(s.store.get("run-1").extensions?.approval?.state).toBe("awaiting-approval");
      // Refused ⇒ byte-identical, like every other refusal in this file.
      expect(fs.readFileSync(s.store.path("run-1"), "utf8")).toBe(before);
    } finally {
      s.cleanup();
    }
  });

  test("no finish carries a decision against a reportId in NEITHER reportId nor supersededReportIds", async () => {
    const s = store();
    try {
      await seed(s.store);
      const d = deps(s.store);
      await requestApproval(d, "run-1", req("rv-2", SHA_B));
      await requestApproval(d, "run-1", req("rv-3", SHA_A));
      const out = await submitDecision(d, "run-1", {
        decision: "approved",
        approverId: "alice",
        reason: "ok",
        reportId: "rv-3",
      });

      // The RETURN VALUE, not just the accumulation. Compare-and-setting
      // against `supersededReportIds[0]` instead of the live `reportId` answers
      // the decision against the CURRENT report with `report-changed` and
      // strands the run at `awaiting-approval` forever — with the history
      // assertion below still perfectly green.
      expect(out).toMatchObject({ outcome: "decided", state: "approved", approverId: "alice" });
      const ext = s.store.get("run-1").extensions?.approval;
      expect(ext?.state).toBe("approved");
      const known = [String(ext?.reportId), ...((ext?.supersededReportIds as string[]) ?? [])];
      expect(known).toEqual(["rv-3", "rv-1", "rv-2"]);
    } finally {
      s.cleanup();
    }
  });

  test("a PAUSING record is not decidable — the box may still be alive", async () => {
    const s = store();
    try {
      s.store.create("run-1");
      seedPausing(s.store, "run-1", "rv-1", { expiresAt: "2026-08-29T12:00:00.000Z" });
      const out = await submitDecision(deps(s.store), "run-1", {
        decision: "approved",
        approverId: "alice",
        reason: "too early",
        reportId: "rv-1",
      });
      expect(out).toEqual({ outcome: "not-decidable", state: "pausing" });
      expect(s.store.get("run-1").extensions?.approval?.state).toBe("pausing");
    } finally {
      s.cleanup();
    }
  });

  test("a record carrying a GARBAGE state string is not decidable, and names the state it found", async () => {
    const s = store();
    try {
      s.store.create("run-1");
      // A hand-edited or half-written record. `Decision` is compile-time only,
      // so nothing stops a typo'd value landing in `state` — and if
      // `submitDecision` fell through the guards it would write a terminal
      // record over it, retroactively "deciding" a run that was never in a
      // decidable state.
      s.store.set("run-1", {
        extensions: { approval: { state: "sometypo", proposal: "p", reportId: "rv-1", headSha: SHA_A } },
      });
      const out = await submitDecision(deps(s.store), "run-1", {
        decision: "approved",
        approverId: "alice",
        reason: "r",
        reportId: "rv-1",
      });
      expect(out).toEqual({ outcome: "not-decidable", state: "sometypo" });
      expect(s.store.get("run-1").extensions?.approval?.state).toBe("sometypo");
    } finally {
      s.cleanup();
    }
  });

  test("a run with NO approval namespace is not decidable", async () => {
    const s = store();
    try {
      s.store.create("run-1");
      // T8: byte-identity, like every other refusal in this file. `not-decidable`
      // must not mint an extension as a side effect of answering.
      const before = fs.readFileSync(s.store.path("run-1"), "utf8");
      const out = await submitDecision(deps(s.store), "run-1", {
        decision: "approved",
        approverId: "alice",
        reason: "r",
        reportId: "rv-1",
      });
      expect(out).toEqual({ outcome: "not-decidable", state: "absent" });
      expect(fs.readFileSync(s.store.path("run-1"), "utf8")).toBe(before);
    } finally {
      s.cleanup();
    }
  });

  test("a PAUSE against a run that does not exist throws, and leaves no record or lock", async () => {
    const s = store();
    try {
      // The strict reader's backstop from the other side: `requestApproval` has
      // no tolerant-read route at all, so a typo'd id is a throw naming the
      // record it could not read — not a freshly created run, and not a
      // `pause-in-progress` answer dressed up as a state.
      await expect(
        requestApproval(deps(s.store), "run-typo", req("rv-1")),
      ).rejects.toThrow(/unreadable run record run-typo\.json/);
      // No record was minted for the typo'd id, and the lock it took on the way
      // in is released, not leaked — a leaked lock would wedge every later
      // correctly-spelled verb for the run.
      expect(fs.existsSync(path.join(s.dir, "run-typo.json"))).toBe(false);
      expect(fs.existsSync(path.join(s.dir, "run-typo.approval.lock"))).toBe(false);
    } finally {
      s.cleanup();
    }
  });

  test("the paused extension survives a fresh store handle — the pause outlives its process", async () => {
    const s = store();
    try {
      await seed(s.store);
      const reopened = new RunRecordStore({ dir: s.dir });
      const out = await submitDecision(deps(reopened), "run-1", {
        decision: "approved",
        approverId: "alice",
        reason: "after restart",
        reportId: "rv-1",
      });
      expect(out.outcome).toBe("decided");
    } finally {
      s.cleanup();
    }
  });
});

describe("AC3 — expiry: derive for status, persist for decisions", () => {
  const past = "2026-08-28T12:00:00.000Z";
  const later = new Date("2026-08-29T12:00:00.000Z");

  test("expiredState DERIVES timed-out past expiresAt without writing", async () => {
    const s = store();
    try {
      s.store.create("run-1");
      await requestApproval(deps(s.store, { now: () => new Date(past), timeoutMs: 60_000 }), "run-1", req("rv-1"));
      const before = fs.readFileSync(s.store.path("run-1"), "utf8");

      const ext = s.store.get("run-1").extensions?.approval;
      expect(expiredState(ext, later)).toBe("timed-out");
      expect(expiredState(ext, new Date(past))).toBe("awaiting-approval");
      // A derive must never touch the record — `fleet status --dir` holds a
      // create:false store that throws on every write.
      expect(fs.readFileSync(s.store.path("run-1"), "utf8")).toBe(before);
    } finally {
      s.cleanup();
    }
  });

  test("expiredState never re-opens a terminal state", () => {
    for (const state of ["approved", "rejected", "timed-out"]) {
      // `schemaVersion: 2` — what the store stamps today (v1 is the pre-migration
      // form; see the singular-scalar test below for that shape).
      expect(expiredState({ schemaVersion: 2, state, expiresAt: past }, later)).toBe(state);
    }
  });

  test("a PAUSING record does not expire — it was never awaiting anybody", () => {
    // The box may still be mid-teardown, and a run that never reached
    // `awaiting-approval` had no window for an approver to miss.
    expect(expiredState({ schemaVersion: 2, state: "pausing", expiresAt: past }, later)).toBe("pausing");
  });

  test("an UNPARSEABLE expiresAt does not expire the run", () => {
    // Timing out is a terminal, irreversible abort. A malformed stamp is not
    // evidence that a deadline passed, and treating it as one would abort a
    // live run over a corrupt field.
    for (const expiresAt of ["", "not-a-date", "2026-13-45T99:99:99Z"]) {
      expect(expiredState({ schemaVersion: 2, state: "awaiting-approval", expiresAt }, later)).toBe("awaiting-approval");
    }
    expect(expiredState({ schemaVersion: 2, state: "awaiting-approval" }, later)).toBe("awaiting-approval");
  });

  test("expiry is strictly PAST expiresAt — the boundary instant is still open", () => {
    const ext = { schemaVersion: 2, state: "awaiting-approval", expiresAt: past };
    expect(expiredState(ext, new Date(Date.parse(past)))).toBe("awaiting-approval");
    expect(expiredState(ext, new Date(Date.parse(past) + 1))).toBe("timed-out");
  });

  test("sweepExpired PERSISTS timed-out with the reserved approverId", async () => {
    const s = store();
    try {
      s.store.create("run-1");
      await requestApproval(deps(s.store, { now: () => new Date(past), timeoutMs: 60_000 }), "run-1", req("rv-1"));
      const swept = await sweepExpired(deps(s.store, { now: () => later }), "run-1");

      expect(swept).toBe(true);
      const ext = s.store.get("run-1").extensions?.approval;
      expect(ext?.state).toBe("timed-out");
      expect(ext?.approverId).toBe(TIMEOUT_APPROVER_ID);
      expect(TIMEOUT_APPROVER_ID).toBe("system:timeout");
      // The expiry INSTANT, not notice-time: the persisted record must agree
      // with the answer a reader derived from the same field a minute earlier.
      expect(String(ext?.decidedAt)).toBe(String(ext?.expiresAt));
    } finally {
      s.cleanup();
    }
  });

  test("a decision arriving AFTER expiresAt finds timed-out and is refused", async () => {
    const s = store();
    try {
      s.store.create("run-1");
      await requestApproval(deps(s.store, { now: () => new Date(past), timeoutMs: 60_000 }), "run-1", req("rv-1"));
      const out = await submitDecision(deps(s.store, { now: () => later }), "run-1", {
        decision: "approved",
        approverId: "alice",
        reason: "too late",
        reportId: "rv-1",
      });

      // Expiry is evaluated BEFORE this invocation's own decision, so a late
      // approve can never reach `approved`.
      expect(out).toMatchObject({ outcome: "already-decided", state: "timed-out", approverId: TIMEOUT_APPROVER_ID });
      expect(s.store.get("run-1").extensions?.approval?.state).toBe("timed-out");
    } finally {
      s.cleanup();
    }
  });

  test("timed-out is TERMINAL — no re-request and no later decision reopens it", async () => {
    const s = store();
    try {
      s.store.create("run-1");
      const d = deps(s.store, { now: () => new Date(past), timeoutMs: 60_000 });
      await requestApproval(d, "run-1", req("rv-1"));
      await sweepExpired(deps(s.store, { now: () => later }), "run-1");
      const before = fs.readFileSync(s.store.path("run-1"), "utf8");

      expect(await requestApproval(deps(s.store), "run-1", req("rv-2", SHA_B))).toEqual({
        outcome: "already-decided",
        state: "timed-out",
      });
      expect(fs.readFileSync(s.store.path("run-1"), "utf8")).toBe(before);

      // T7: the DECISION half of "terminal". The re-request above is only one of
      // the two ways back in; a `submitDecision` against the swept record must
      // be answered with the timeout that was persisted, and must not reopen it
      // by writing over it.
      const decided = await submitDecision(deps(s.store), "run-1", {
        decision: "approved",
        approverId: "alice",
        reason: "late",
        reportId: "rv-1",
      });
      expect(decided).toMatchObject({
        outcome: "already-decided",
        state: "timed-out",
        approverId: TIMEOUT_APPROVER_ID,
      });
      expect(fs.readFileSync(s.store.path("run-1"), "utf8")).toBe(before);
    } finally {
      s.cleanup();
    }
  });

  test("sweepExpired never overwrites a decision that landed first", async () => {
    const s = store();
    try {
      s.store.create("run-1");
      await requestApproval(deps(s.store, { now: () => new Date(past), timeoutMs: 60_000 }), "run-1", req("rv-1"));
      await submitDecision(deps(s.store, { now: () => new Date(past) }), "run-1", {
        decision: "approved",
        approverId: "alice",
        reason: "in time",
        reportId: "rv-1",
      });
      const swept = await sweepExpired(deps(s.store, { now: () => later }), "run-1");

      expect(swept).toBe(false);
      expect(s.store.get("run-1").extensions?.approval?.approverId).toBe("alice");
    } finally {
      s.cleanup();
    }
  });

  test("sweepExpired tolerates a run whose record is gone", async () => {
    const s = store();
    try {
      expect(await sweepExpired(deps(s.store), "no-such-run")).toBe(false);
    } finally {
      s.cleanup();
    }
  });

  test("sweepExpired never sweeps a PAUSING record, however long the crash has been", async () => {
    const s = store();
    try {
      s.store.create("run-1");
      // `pausing` was never awaiting anybody, so it has no window to miss: the
      // record below is YEARS past any plausible deadline. Sweeping it here
      // would abort a run that may still be mid-teardown — the exact state
      // AC1(c)'s resume exists to recover.
      seedPausing(s.store, "run-1", "rv-1");
      const before = fs.readFileSync(s.store.path("run-1"), "utf8");
      const swept = await sweepExpired(deps(s.store, { now: () => new Date("2099-06-01T00:00:00.000Z") }), "run-1");

      expect(swept).toBe(false);
      expect(fs.readFileSync(s.store.path("run-1"), "utf8")).toBe(before);
    } finally {
      s.cleanup();
    }
  });

  test("awaitDecision answers a run that DOES NOT EXIST with null, inside the caller's own window", async () => {
    const s = store();
    try {
      // The poller's tolerant reader: absence is an ordinary observation, not a
      // throw. But tolerance must not become an open-ended wait — the caller's
      // window is what bounds this, so the answer arrives promptly rather than
      // at the 24h default.
      const t0 = Date.now();
      await expect(awaitDecision(deps(s.store), "no-such-run", { pollMs: 5, waitMs: 40 })).resolves.toBeNull();
      // A LOWER bound would be jitter; the UPPER bound is the pin — the answer
      // is the caller's own 40ms window plus at most a poll and scheduler
      // slop, so a poller that oversleeps by 10-50x (a clamp regression) reds
      // here instead of only on a wedge of three orders of magnitude.
      expect(Date.now() - t0).toBeLessThan(200);
    } finally {
      s.cleanup();
    }
  });
});

describe("awaitDecision", () => {
  test("resolves with the decision once one lands", async () => {
    const s = store();
    try {
      s.store.create("run-1");
      await requestApproval(deps(s.store), "run-1", req("rv-1"));
      const waiting = awaitDecision(deps(s.store), "run-1", { pollMs: 5, waitMs: 5_000 });
      await submitDecision(deps(s.store), "run-1", {
        decision: "approved",
        approverId: "alice",
        reason: "ok",
        reportId: "rv-1",
      });
      await expect(waiting).resolves.toMatchObject({ state: "approved", approverId: "alice" });
    } finally {
      s.cleanup();
    }
  });

  test("returns the already-terminal decision without waiting", async () => {
    const s = store();
    try {
      s.store.create("run-1");
      await requestApproval(deps(s.store), "run-1", req("rv-1"));
      await submitDecision(deps(s.store), "run-1", {
        decision: "rejected",
        approverId: "bob",
        reason: "no",
        reportId: "rv-1",
      });
      const t0 = Date.now();
      await expect(awaitDecision(deps(s.store), "run-1", { pollMs: 5, waitMs: 50 })).resolves.toMatchObject({
        state: "rejected",
      });
      // WITHOUT waiting: the first poll already sees the terminal state, so the
      // answer lands within one poll plus slop — not after the given window.
      expect(Date.now() - t0).toBeLessThan(50);
    } finally {
      s.cleanup();
    }
  });

  test("gives up rather than waiting forever on an undecided run", async () => {
    const s = store();
    try {
      s.store.create("run-1");
      await requestApproval(deps(s.store), "run-1", req("rv-1"));
      await expect(awaitDecision(deps(s.store), "run-1", { pollMs: 5, waitMs: 40 })).resolves.toBeNull();
    } finally {
      s.cleanup();
    }
  });

  test("a pollMs LONGER than the window is clamped to what is LEFT — the answer never lands late (G9)", async () => {
    const s = store();
    try {
      s.store.create("run-1");
      await requestApproval(deps(s.store), "run-1", req("rv-1"));
      // Each nap is `min(pollMs, deadline - now)`, so a caller handing in a
      // day-long poll against a 60ms window still gets its `null` inside the
      // window it asked to observe. Without the clamp the loop oversleeps by
      // the whole poll — a 24h answer to a 60ms question.
      const t0 = Date.now();
      await expect(awaitDecision(deps(s.store), "run-1", { pollMs: 24 * 60 * 60 * 1000, waitMs: 60 })).resolves.toBeNull();
      expect(Date.now() - t0).toBeLessThan(1_000);
    } finally {
      s.cleanup();
    }
  });

  test("a zero or negative pollMs is CLAMPED to the floor — still a poll, never a busy-spin", async () => {
    const s = store();
    try {
      s.store.create("run-1");
      await requestApproval(deps(s.store), "run-1", req("rv-1"));
      // Unclamped, `Bun.sleep(0)` makes the loop a synchronous filesystem
      // busy-spin for the whole `waitMs`. The clamp itself is not directly
      // observable from outside; what this pins is that a degenerate
      // interval still behaves as a waiter — resolves with the decision,
      // honours the window — rather than wedging or throwing.
      const waiting = awaitDecision(deps(s.store), "run-1", { pollMs: 0, waitMs: 5_000 });
      await submitDecision(deps(s.store), "run-1", {
        decision: "approved",
        approverId: "alice",
        reason: "ok",
        reportId: "rv-1",
      });
      await expect(waiting).resolves.toMatchObject({ state: "approved", approverId: "alice" });
      await expect(awaitDecision(deps(s.store), "run-1", { pollMs: -50, waitMs: 5_000 })).resolves.toMatchObject({
        state: "approved",
      });
    } finally {
      s.cleanup();
    }
  });

  test.each([[0], [-1]])("a non-positive waitMs (%p) fires INSTANTLY — 'wait zero' is reported, not silent", async (waitMs) => {
    const s = store();
    try {
      s.store.create("run-1");
      await requestApproval(deps(s.store), "run-1", req("rv-1"));
      // The clamp is `Math.max(requestedWait, 0)`, so 0 and below share one
      // boundary: the deadline is already past on loop entry, and the answer
      // is an immediate null without a single poll — the caller asked to wait
      // no time and was told honestly that nothing arrived.
      const t0 = Date.now();
      await expect(awaitDecision(deps(s.store), "run-1", { pollMs: 5, waitMs })).resolves.toBeNull();
      // "wait zero" fires without a single poll; the bound is scheduler slop,
      // not the window, so a poller that burned even a fraction of it reds.
      expect(Date.now() - t0).toBeLessThan(200);
    } finally {
      s.cleanup();
    }
  });
});

describe("INV-APPROVE / R5-C — never a clean pause over a possibly-live key", () => {
  test("a box with no keyHash on an OPEN record refuses the pause, leaving evidence", async () => {
    const s = store();
    try {
      s.store.create("run-1");
      // The crash window DF3.1 already refuses for `fleet teardown`: the box
      // was provisioned and the record persisted, but the mint never wrote its
      // keyHash — so a key may be live and billing with nothing pointing at it.
      s.store.set("run-1", { vmName: "run-1" });
      const log: string[] = [];
      // A8: the tail NAMES THE PERSISTENT BLOCKER. The old message read as if
      // re-running reverify might clear it; the run stays `pausing` and every
      // later reverify re-refuses here until the key is accounted for, so the
      // text has to say that rather than imply a transient fault.
      await expect(
        requestApproval(deps(s.store, { teardown: recordingTeardown(s.store, log) }), "run-1", req("rv-1")),
      ).rejects.toThrow(/no keyHash, so a minted key may still be live[\s\S]*The key-ledger gap is the blocker/);

      // Refused BEFORE teardown — the box is untouched and can be inspected.
      expect(log).toEqual([]);
      // …and the evidence-first write still stands, so the run is recoverable.
      expect(s.store.get("run-1").extensions?.approval?.state).toBe("pausing");
    } finally {
      s.cleanup();
    }
  });

  test("an OPEN record still owning a box refuses to promote with no teardown seam", async () => {
    const s = store();
    try {
      s.store.create("run-1");
      // A fully-minted, still-running box: R5-C's keyHash arm is satisfied, so
      // this is the OTHER half of INV-APPROVE-6 — `await deps.teardown?.(...)`
      // on an absent seam is a no-op that promotes `awaiting-approval` over a
      // box that is still alive and still billing, and looks in every log
      // exactly like a teardown that ran.
      s.store.set("run-1", { vmName: "run-1", keyHash: "h".repeat(64) });
      // A8: same discipline as the key-ledger arm — the refusal names the live
      // box as the persistent blocker (and the teardown verb that clears it),
      // never a crashed pause a re-run would fix.
      await expect(requestApproval(deps(s.store), "run-1", req("rv-1"))).rejects.toThrow(
        /no teardown seam[\s\S]*run `fleet teardown run-1` first[\s\S]*The live box is the blocker/,
      );

      // Refused, not promoted — and the evidence-first write still stands, so
      // the run is recoverable and the refusal is auditable.
      expect(s.store.get("run-1").extensions?.approval?.state).toBe("pausing");
    } finally {
      s.cleanup();
    }
  });

  test("an OPEN record naming ONLY a keyHash refuses the promote tail with no teardown seam (G2)", async () => {
    const s = store();
    try {
      s.store.create("run-1");
      // The half-open crash window the other arm names a box for: `vmName`
      // never landed but the mint's keyHash did, so a key may be live with
      // nothing on the record pointing at a box to destroy. Same guard, same
      // posture — and the noun says KEY, because sending an operator looking
      // for a VM that does not exist is its own failure.
      s.store.set("run-1", { vmName: undefined, keyHash: "k".repeat(64) });
      await expect(requestApproval(deps(s.store), "run-1", req("rv-1"))).rejects.toThrow(
        /still owns a minted key[\s\S]*no teardown seam[\s\S]*The live infrastructure is the blocker/,
      );

      // Refused, not promoted — the evidence-first `pausing` write stands, so
      // the run is recoverable and the refusal is auditable.
      expect(s.store.get("run-1").extensions?.approval?.state).toBe("pausing");
    } finally {
      s.cleanup();
    }
  });

  test("a CLOSED record with no teardown seam promotes — its box is provably gone", async () => {
    const s = store();
    try {
      s.store.create("run-1");
      s.store.set("run-1", { vmName: "run-1", keyHash: "h".repeat(64) });
      s.store.close("run-1");
      // `closedAt` is the record settling the "already gone" claim, which is
      // the reverify runner's case: the box died before the host verdict.
      const out = await requestApproval(deps(s.store), "run-1", req("rv-1"));
      expect(out).toEqual({ outcome: "requested" });
      expect(s.store.get("run-1").extensions?.approval?.state).toBe("awaiting-approval");
    } finally {
      s.cleanup();
    }
  });

  test("a box WITH a keyHash pauses normally", async () => {
    const s = store();
    try {
      s.store.create("run-1");
      s.store.set("run-1", { vmName: "run-1", keyHash: "h".repeat(64) });
      const log: string[] = [];
      const out = await requestApproval(deps(s.store, { teardown: recordingTeardown(s.store, log) }), "run-1", req("rv-1"));
      expect(out).toEqual({ outcome: "requested" });
      expect(log).toEqual(["teardown:run-1:pausing"]);
    } finally {
      s.cleanup();
    }
  });
});

describe("withApprovalLock — reclamation is a cross-PROCESS decision", () => {
  // The four in-process arms of the acquire loop (dead-pid steal, own-live-pid
  // refusal, the replacement-lock race, the `claimed` fail-closed restore) live
  // in tests/reverify/approval.test.ts's replacement-race and restore-failure
  // cases and are not repeated here. What that file cannot reach is the
  // LIVENESS PREDICATE itself and the age escape above it — both decided from a
  // lock file this process never wrote.

  test.skipIf(pid1Probe !== "EPERM")("a lock held by a LIVE FOREIGN process (EPERM) is never reclaimed", async () => {
    const s = store();
    try {
      // THE PRECONDITION, asserted rather than assumed: pid 1 must be
      // root-owned relative to us, so `process.kill(1, 0)` raises EPERM
      // rather than ESRCH. As root (default Docker CI) or in a user-owned
      // pid namespace the probe SUCCEEDS, the EPERM arm of
      // `isLockHolderDead` is unreachable, and this test would be vacuous —
      // green without exercising anything. That is why the skip above is
      // loud (a stderr line at load) instead of silent.
      expect(pid1Probe).toBe("EPERM");
      s.store.create("run-1");
      const lock = path.join(s.dir, "run-1.approval.lock");
      // EPERM means "alive but not ours", and `isLockHolderDead` returning
      // `true` on ANY kill error (rather than on ESRCH alone) would let this
      // process steal a live holder's lock. The own-pid test next door
      // cannot catch that: `kill(self, 0)` never throws, so the broken
      // predicate answers "not dead" there for the wrong reason.
      fs.writeFileSync(lock, "1:foreign-live-holder");
      const old = new Date(Date.now() - 60_000); // stale by age, NOT by liveness
      fs.utimesSync(lock, old, old);

      await expect(withApprovalLock(s.dir, "run-1", () => "entered")).rejects.toThrow(/held for over/);
      // Untouched: not stolen, not renamed away, not emptied.
      expect(fs.readFileSync(lock, "utf8")).toBe("1:foreign-live-holder");
    } finally {
      s.cleanup();
    }
    // G10: the ceiling is 15 s now (three times the store's own worst-case
    // blocking wait), so this test waits out the whole window for real.
  }, 45_000);

  // ── D11: the age-only abandon door is GONE ─────────────────────────────────
  //
  // This block REPLACES two tests that asserted the opposite ("a lock past the
  // ABANDON age is reclaimed even though its pid still resolves", and its paired
  // hour-scale-constant guard). They were not wrong about the code — they pinned
  // `LOCK_ABANDON_MS` faithfully — they pinned a DESIGN that D11 removed, which
  // is the one reason a passing test may be inverted rather than preserved.
  //
  // The design it removed: reclaiming from a holder that cannot be proven dead
  // means two processes are inside the critical section BY DESIGN, and three
  // review rounds each found a different symptom of that and each patched the
  // release instead. The wedge the door protected against (a recycled pid, where
  // death can never be proven) is real and is now answered by `fleet unlock`.

  test("a ZERO-BYTE lock past the stale window is auto-reclaimed — an empty lock names no holder", async () => {
    // A2: the stranded shape is a crash between the `wx` and the content
    // write. Its content write never landed, so it names NO pid — and no waiter
    // can ever prove that holder dead, which used to wedge the run past every
    // timeout until an operator deleted the file by hand. An empty lock cannot
    // have anybody behind it, so past LOCK_STALE_MS it reclaims without one.
    const s = store();
    try {
      s.store.create("run-1");
      const lock = path.join(s.dir, "run-1.approval.lock");
      fs.writeFileSync(lock, ""); // zero bytes of content
      const ancient = new Date(Date.now() - 60_000);
      fs.utimesSync(lock, ancient, ancient);

      // Asserted INSIDE the body: after the body returns the fenced release
      // removes this acquisition's lock, so the file's existence afterwards is
      // the ordinary absence, not evidence either way.
      const inside = await withApprovalLock(s.dir, "run-1", () => {
        expect(fs.existsSync(lock)).toBe(true);
        expect(fs.readFileSync(lock, "utf8").startsWith(`${process.pid}:`)).toBe(true);
        return "entered";
      });
      expect(inside).toBe("entered");
    } finally {
      s.cleanup();
    }
  }, 15_000);

  test("a NON-EMPTY but unparseable lock is still NOT auto-reclaimed — proof of death, or nothing", async () => {
    // A2's fail-safe half: only the EMPTY content is the stranded shape. A file
    // whose content exists but carries no parseable pid (hand-edited, truncated
    // mid-write of the pid field) is NOT proven to name no holder, and the
    // auto-reclaim must not stretch to cover it — that is `fleet unlock`'s job.
    const s = store();
    try {
      s.store.create("run-1");
      const lock = path.join(s.dir, "run-1.approval.lock");
      fs.writeFileSync(lock, "not-a-pid");
      const ancient = new Date(Date.now() - 60_000);
      fs.utimesSync(lock, ancient, ancient);

      await expect(withApprovalLock(s.dir, "run-1", () => "entered")).rejects.toThrow(/held for over/);
      // Untouched — the wedge is the price of the guarantee, and the operator
      // override is the remedy.
      expect(fs.readFileSync(lock, "utf8")).toBe("not-a-pid");
    } finally {
      s.cleanup();
    }
    // G10: waits out the full 15 s window.
  }, 45_000);

  test("a FRESH empty lock is NOT auto-reclaimed — age is the precondition for even looking (control)", async () => {
    // T15: the control for the zero-byte test above — the SAME stranded bytes,
    // never backdated. An empty lock reclaims only past LOCK_STALE_MS, so a
    // fresh one (which a live writer is mid-populating) is waited on, not
    // stolen: without this control, deleting the age precondition would pass
    // the reclaim test and hand the critical section to whoever polls first.
    const s = store();
    try {
      s.store.create("run-1");
      const lock = path.join(s.dir, "run-1.approval.lock");
      fs.writeFileSync(lock, "");
      await expect(withApprovalLock(s.dir, "run-1", () => "entered")).rejects.toThrow(/held for over/);
      // Untouched and still empty: the door never read it, so it neither wrote
      // to nor removed it.
      expect(fs.existsSync(lock)).toBe(true);
      expect(fs.readFileSync(lock, "utf8")).toBe("");
    } finally {
      s.cleanup();
    }
    // G10: waits out the full 15 s window.
  }, 45_000);

  test("a lock whose pid still resolves is NEVER reclaimed, however old (D11)", async () => {
    const s = store();
    try {
      s.store.create("run-1");
      const lock = path.join(s.dir, "run-1.approval.lock");
      // Own pid: verifiably alive, so the liveness predicate can never prove
      // death — exactly what a recycled pid looks like once the OS wraps onto a
      // dead holder's number. TWO HOURS, deliberately past the hour the deleted
      // door used: if any age-based escape is ever reintroduced, this reds.
      fs.writeFileSync(lock, `${process.pid}:recycled-pid`);
      const ancient = new Date(Date.now() - 2 * 60 * 60 * 1000);
      fs.utimesSync(lock, ancient, ancient);

      await expect(withApprovalLock(s.dir, "run-1", () => "entered")).rejects.toThrow(/held for over/);
      // Untouched. The wedge is the PRICE of the guarantee, and it is bounded to
      // this one run with an operator remedy — see the `reclaimApprovalLock`
      // block below, which is the other half of this decision.
      expect(fs.readFileSync(lock, "utf8")).toBe(`${process.pid}:recycled-pid`);
      // …and the refusal names the remedy rather than telling an operator to
      // delete files out of the runs directory by hand.
      await expect(withApprovalLock(s.dir, "run-1", () => "entered")).rejects.toThrow(/fleet unlock run-1/);
    } finally {
      s.cleanup();
    }
    // G10: TWO full waits (the refusal is asserted twice), 15 s each.
  }, 90_000);

  test("an EPERM kill error means LIVE, whatever the environment can produce naturally (EPERM arm)", async () => {
    // The test above this block needs pid 1 to be root-owned relative to us to
    // reach `isLockHolderDead`'s EPERM arm naturally — true on a shared macOS
    // host, FALSE as root (default Docker CI) or in a user-owned pid namespace,
    // where the arm is silently never exercised. This twin injects the EPERM
    // directly, so the arm has a test everywhere the suite runs: a predicate
    // that answers `true` on ANY kill error (rather than ESRCH alone) would let
    // a process steal a live foreign holder's lock, and the own-pid tests
    // cannot catch that (`kill(self, 0)` never throws).
    const s = store();
    const killSpy = spyOn(process, "kill").mockImplementation(((() => {
      const err = new Error("operation not permitted") as NodeJS.ErrnoException;
      err.code = "EPERM";
      throw err;
    }) as unknown) as typeof process.kill);
    try {
      s.store.create("run-1");
      const lock = path.join(s.dir, "run-1.approval.lock");
      fs.writeFileSync(lock, "1:foreign-live-holder");
      const old = new Date(Date.now() - 60_000); // stale by age, alive by liveness
      fs.utimesSync(lock, old, old);

      await expect(withApprovalLock(s.dir, "run-1", () => "entered")).rejects.toThrow(/held for over/);
      expect(fs.readFileSync(lock, "utf8")).toBe("1:foreign-live-holder");

      // The same posture on the verb: EPERM reports `alive`, refuses without
      // force, and the forced removal then stays the only way through.
      const refused = reclaimApprovalLock(s.dir, "run-1", false);
      expect(refused).toMatchObject({ outcome: "refused", holder: "alive", holderPid: 1 });
      expect(fs.existsSync(lock)).toBe(true);
      expect(reclaimApprovalLock(s.dir, "run-1", true).outcome).toBe("reclaimed");
      // T13: the EPERM was actually CONSULTED. Without this the test also passes
      // if `isLockHolderDead` was never called at all — e.g. a predicate that
      // stopped being reached after a refactor — and the arm goes unexercised
      // while the suite stays green.
      expect(killSpy).toHaveBeenCalled();
    } finally {
      killSpy.mockRestore();
      s.cleanup();
    }
    // G10: waits out the full 15 s window.
  }, 45_000);

  test("a holder suspended between its `wx` and its content write does NOT enter the body after a reclaim (G1)", async () => {
    // The acquire is open-then-write, and the re-verify through the PATH between
    // the two is what stops a holder suspended for longer than LOCK_STALE_MS
    // from entering `body()` beside the waiter that reclaimed its empty lock —
    // the holder's own fd then names an unlinked inode, which `fstatSync` alone
    // would happily report as a win. No seam exists at which a test can suspend
    // a holder, so the suspension is simulated exactly where it happens: the
    // content write is intercepted, and a real waiter runs inside that window.
    const s = store();
    let writeSpy: { mockRestore(): void } | undefined;
    try {
      s.store.create("run-1");
      const lock = path.join(s.dir, "run-1.approval.lock");
      let intercepted = false;
      let holderEntered = false;
      let waiterEntered = false;
      let waiter: Promise<string> | undefined;
      const realWriteFileSync = fs.writeFileSync;
      writeSpy = spyOn(fs, "writeFileSync").mockImplementation(((target, data, opts) => {
        // The lock's content write is the first fd-targeted write in this test;
        // the waiter's own is the second and passes through.
        if (typeof target === "number" && !intercepted) {
          intercepted = true;
          // The suspension outlasted LOCK_STALE_MS: backdate the empty lock the
          // `wx` left behind, then push the clock past THIS holder's deadline so
          // its loss surfaces as the timeout instead of spinning.
          const ancient = new Date(Date.now() - 60_000);
          fs.utimesSync(lock, ancient, ancient);
          setSystemTime(new Date(Date.now() + 20_000));
          // The waiter, for real: its synchronous prefix reaches the
          // rename-and-remove reclaim before its first await.
          waiter = withApprovalLock(s.dir, "run-1", () => {
            waiterEntered = true;
            return "waiter-done";
          });
          return; // deliberately no content: the holder's fd is now unlinked
        }
        return realWriteFileSync(target, data, opts);
      }) as typeof fs.writeFileSync);

      let holderErr: unknown;
      try {
        await withApprovalLock(s.dir, "run-1", () => {
          holderEntered = true;
          return "holder-done";
        });
      } catch (e) {
        holderErr = e;
      }

      // The simulation landed where it meant to, and the holder did NOT walk
      // into `body()` on its unlinked inode: the re-verify saw a foreign (here
      // vanished) path and surfaced the loss. A deleted re-verify breaks out of
      // the loop and sets holderEntered BEFORE the waiter is ever admitted.
      expect(intercepted).toBe(true);
      expect(holderEntered).toBe(false);
      expect((holderErr as Error).message).toContain("held for over");
      // The waiter is settled BEFORE it is asserted on: it spends its first
      // 10ms asleep after the reclaim, so checking its body flag first reads a
      // value that has not been set yet — and worse, leaving it un-awaited
      // would let it wake after this test's cleanup and blow up inside the
      // NEXT test's directory.
      await expect(waiter).resolves.toBe("waiter-done");
      expect(waiterEntered).toBe(true);
      // The waiter's ordinary release still happened.
      expect(fs.existsSync(lock)).toBe(false);
    } finally {
      setSystemTime(); // restore the real clock for every other test
      writeSpy?.mockRestore();
      s.cleanup();
    }
  });

  test("a BACKWARD clock step cannot spin the wait past its own budget — accumulated sleep fires the deadline (G11)", async () => {
    // `Date.now() >= deadline` is the wall gate, and a clock frozen BEFORE the
    // deadline makes it false forever — the NTP-correction / resumed-laptop
    // shape. Only the accumulated-sleep belt can end this loop, so this test
    // really pays ~15 s of polls; an implementation that trusts the wall clock
    // alone never exits and reds on the timeout.
    const s = store();
    try {
      s.store.create("run-1");
      setSystemTime(new Date(Date.now())); // frozen: never advances
      const lock = path.join(s.dir, "run-1.approval.lock");
      // Own pid: provably alive, so the reclaim door never opens and the
      // deadline is the only exit.
      fs.writeFileSync(lock, `${process.pid}:frozen-clock-holder`);
      await expect(withApprovalLock(s.dir, "run-1", () => "entered")).rejects.toThrow(/held for over/);
      // Untouched: the belt ended the wait, it did not steal the lock.
      expect(fs.readFileSync(lock, "utf8")).toBe(`${process.pid}:frozen-clock-holder`);
    } finally {
      setSystemTime(); // restore the real clock for every other test
      s.cleanup();
    }
    // G10: the belt is 15 s of real polling.
  }, 45_000);

  test("a GENUINELY CONCURRENT holder is not evicted by age — two real processes, one real lock", async () => {
    // The item's mandated proof, and the one the in-process arms cannot give:
    // every other test here simulates a holder by WRITING a lock file, which is
    // faithful for the release but cannot exercise a process that is actually
    // parked inside `body()`. Here process A really holds it and process B
    // really waits.
    const s = store();
    const children: ReturnType<typeof Bun.spawn>[] = [];
    try {
      s.store.create("run-1");
      const lock = path.join(s.dir, "run-1.approval.lock");
      const release = path.join(s.dir, "release-holder");
      const inside = path.join(s.dir, "holder-inside");

      // A: acquires for real and parks INSIDE the body until told to leave.
      children.push(
        Bun.spawn(
          [
            "bun",
            "-e",
            `const { withApprovalLock } = await import(${JSON.stringify(path.join(REPO_SRC, "fleet", "approval-gate.ts"))});
             const fs = await import("node:fs");
             await withApprovalLock(${JSON.stringify(s.dir)}, "run-1", async () => {
               fs.writeFileSync(${JSON.stringify(inside)}, String(process.pid));
               while (!fs.existsSync(${JSON.stringify(release)})) await Bun.sleep(5);
             });`,
          ],
          { stdout: "pipe", stderr: "pipe" },
        ),
      );
      // T14: a 5 s budget (500 x 10ms). A cold `bun -e` child can take longer
      // than 4 s to import the store on a loaded box, and the failure should be
      // the expect below rather than a premature give-up.
      for (let i = 0; i < 500 && !fs.existsSync(inside); i++) await Bun.sleep(10);
      expect(fs.existsSync(inside)).toBe(true);
      const holderPid = fs.readFileSync(inside, "utf8");
      const held = fs.readFileSync(lock, "utf8");
      expect(held.startsWith(`${holderPid}:`)).toBe(true);

      // Backdated on the REAL lock file of a REAL live holder. Before D11 this
      // is the whole exploit: B reads an age past the door and evicts A while A
      // is still executing.
      const ancient = new Date(Date.now() - 2 * 60 * 60 * 1000);
      fs.utimesSync(lock, ancient, ancient);

      // B: a second real process that wants the same lock.
      const contender = Bun.spawn(
        [
          "bun",
          "-e",
          `const { withApprovalLock } = await import(${JSON.stringify(path.join(REPO_SRC, "fleet", "approval-gate.ts"))});
           try {
             await withApprovalLock(${JSON.stringify(s.dir)}, "run-1", () => "ENTERED");
             console.log("ENTERED");
           } catch (e) { console.log("REFUSED:" + e.message); }`,
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      children.push(contender);
      const seen = await new Response(contender.stdout).text();
      await contender.exited;

      // What B observed: refused, never admitted. An `ENTERED` here is two
      // processes in one critical section.
      expect(seen).toContain("REFUSED:");
      expect(seen).toContain("held for over");
      expect(seen).not.toContain("ENTERED");
      // What A still owns: its own lock, byte-identical and never renamed away.
      expect(fs.readFileSync(lock, "utf8")).toBe(held);

      // A leaves normally and releases — proving the refusal above was mutual
      // exclusion working, not a deadlock.
      fs.writeFileSync(release, "");
      expect(await children[0]!.exited).toBe(0);
      expect(fs.existsSync(lock)).toBe(false);
      expect(await withApprovalLock(s.dir, "run-1", () => "reacquired")).toBe("reacquired");
    } finally {
      for (const c of children) c.kill();
      // T18: the children are dead BEFORE their runs directory is removed — a
      // child still holding an open fd (or still polling) under a deleted dir
      // turns a cleanup into a cross-test race.
      await Promise.all(children.map((c) => c.exited));
      s.cleanup();
    }
  }, 60_000);

  test("`fleet unlock --force` evicts a live holder, and that holder's release touches the successor's lock", async () => {
    // The other half of D11: the escape hatch moved OUT of the acquire loop and
    // INTO an operator's hands, so the eviction still exists but is deliberate,
    // auditable, and never automatic. This is also the case that makes the
    // identity fence in the release load-bearing rather than vestigial — with
    // the age door gone it is the ONLY way a holder can be evicted mid-body.
    const s = store();
    const children: ReturnType<typeof Bun.spawn>[] = [];
    try {
      s.store.create("run-1");
      const lock = path.join(s.dir, "run-1.approval.lock");
      const release = path.join(s.dir, "release-holder");
      const inside = path.join(s.dir, "holder-inside");
      const successorInside = path.join(s.dir, "successor-inside");
      const successorRelease = path.join(s.dir, "release-successor");

      const parkedHolder = (marker: string, gate: string) =>
        Bun.spawn(
          [
            "bun",
            "-e",
            `const { withApprovalLock } = await import(${JSON.stringify(path.join(REPO_SRC, "fleet", "approval-gate.ts"))});
             const fs = await import("node:fs");
             await withApprovalLock(${JSON.stringify(s.dir)}, "run-1", async () => {
               fs.writeFileSync(${JSON.stringify(marker)}, String(process.pid));
               while (!fs.existsSync(${JSON.stringify(gate)})) await Bun.sleep(5);
             });`,
          ],
          { stdout: "pipe", stderr: "pipe" },
        );

      children.push(parkedHolder(inside, release));
      // T14: a 5 s budget (500 x 10ms). A cold `bun -e` child can take longer
      // than 4 s to import the store on a loaded box, and the failure should be
      // the expect below rather than a premature give-up.
      for (let i = 0; i < 500 && !fs.existsSync(inside); i++) await Bun.sleep(10);
      expect(fs.existsSync(inside)).toBe(true);

      // Refused first: the holder is genuinely alive, so without the override
      // this reports rather than acts. `holder: "alive"` is the honest word —
      // this host CANNOT distinguish the real holder from a recycled pid, and
      // the verb says so instead of guessing.
      const refused = reclaimApprovalLock(s.dir, "run-1", false);
      expect(refused.outcome).toBe("refused");
      expect(refused).toMatchObject({ holder: "alive" });
      expect(fs.existsSync(lock)).toBe(true);

      // Forced: the operator asserts what the host cannot prove.
      const forced = reclaimApprovalLock(s.dir, "run-1", true);
      expect(forced.outcome).toBe("reclaimed");
      expect(fs.existsSync(lock)).toBe(false);

      // A successor legitimately takes the freed path while the original holder
      // is STILL inside its body.
      children.push(parkedHolder(successorInside, successorRelease));
      for (let i = 0; i < 500 && !fs.existsSync(successorInside); i++) await Bun.sleep(10);
      expect(fs.existsSync(successorInside)).toBe(true);
      const successorLock = fs.readFileSync(lock, "utf8");
      const successorIno = fs.statSync(lock).ino;

      // The original holder now finishes and runs its release. THE ASSERTION:
      // it must not remove a lock it does not own. An unconditional `rmSync`
      // here hands a third waiter the critical section while the successor is
      // still in it — the defect three review rounds kept re-finding.
      fs.writeFileSync(release, "");
      expect(await children[0]!.exited).toBe(0);
      expect(fs.existsSync(lock)).toBe(true);
      expect(fs.readFileSync(lock, "utf8")).toBe(successorLock);
      expect(fs.statSync(lock).ino).toBe(successorIno);

      fs.writeFileSync(successorRelease, "");
      expect(await children[1]!.exited).toBe(0);
      expect(fs.existsSync(lock)).toBe(false);
    } finally {
      for (const c of children) c.kill();
      // T18: the children are dead BEFORE their runs directory is removed — a
      // child still holding an open fd (or still polling) under a deleted dir
      // turns a cleanup into a cross-test race.
      await Promise.all(children.map((c) => c.exited));
      s.cleanup();
    }
  }, 60_000);

  test("reclaimApprovalLock: absent is success, a dead holder needs no force, a bad id is refused", () => {
    const s = store();
    try {
      s.store.create("run-1");
      const lock = path.join(s.dir, "run-1.approval.lock");

      // No lock at all is the HEALTHY answer to "is this run wedged?", so it is
      // an outcome, not an error — the CLI exits 0 on it.
      expect(reclaimApprovalLock(s.dir, "run-1", false)).toMatchObject({ outcome: "absent" });

      // A provably-dead holder needs no override: the acquire loop would have
      // reclaimed this itself, so refusing here would be stricter than the lock.
      // pid 2^31-1 is above every configured pid_max, so it cannot resolve.
      fs.writeFileSync(lock, "2147483647:dead-holder");
      const dead = reclaimApprovalLock(s.dir, "run-1", false);
      expect(dead).toMatchObject({ outcome: "reclaimed", holder: "dead" });
      expect(fs.existsSync(lock)).toBe(false);

      // Unparseable content is NOT dead — it is unproven, and unproven death is
      // never reclaimed implicitly. This is the arm that keeps a hand-edited or
      // truncated lock from being swept without an operator saying so.
      fs.writeFileSync(lock, "not-a-pid");
      expect(reclaimApprovalLock(s.dir, "run-1", false)).toMatchObject({ outcome: "refused", holder: "unknown" });
      expect(fs.existsSync(lock)).toBe(true);
      expect(reclaimApprovalLock(s.dir, "run-1", true)).toMatchObject({ outcome: "reclaimed", holder: "unknown" });
      expect(fs.existsSync(lock)).toBe(false);

      // Same grammar as the lock itself: this builds a path and then DELETES
      // it, so an unvalidated id is an arbitrary-unlink primitive.
      // T17: the canary is the file the hostile id would ACTUALLY have removed.
      // `join(dir, "../X")` resolves OUTSIDE `dir`, so a canary left inside
      // `dir` survives a broken implementation too and proves nothing.
      const canaryName = `canary-${path.basename(s.dir)}`;
      const canary = path.join(path.dirname(s.dir), `${canaryName}.approval.lock`);
      fs.writeFileSync(canary, "must survive");
      try {
        expect(() => reclaimApprovalLock(s.dir, path.join("..", canaryName), true)).toThrow(/invalid run id/);
        expect(fs.readFileSync(canary, "utf8")).toBe("must survive");
      } finally {
        fs.rmSync(canary, { force: true });
      }
    } finally {
      s.cleanup();
    }
  });

  test("a lock REPLACED between the inspection and the claim is reported `changed`, never followed", () => {
    const s = store();
    try {
      s.store.create("run-1");
      const lock = path.join(s.dir, "run-1.approval.lock");
      const inspected = "1:holder-at-inspection";
      fs.writeFileSync(lock, inspected);

      // Race the verb exactly at its fence: the inspection reads `path`, then
      // the rename claims it — that rename is where a real successor lands in
      // production. The spy substitutes one there: by the time the rename
      // runs, `path` holds a NEW file (new inode, `wx` after an unlink mints
      // one rather than overwriting in place), so the rename CAPTURES the
      // successor's lock and the verb must give it back, never unlink it.
      const successor = "999999:successor-nonce";
      const realRenameSync = fs.renameSync;
      let renames = 0;
      const spy = spyOn(fs, "renameSync").mockImplementation(((...args: Parameters<typeof fs.renameSync>) => {
        if (args[0] === lock && renames++ === 0) {
          fs.rmSync(lock, { force: true });
          fs.writeFileSync(lock, successor, { flag: "wx" });
        }
        return realRenameSync(...args);
      }) as typeof fs.renameSync);
      let result: ReturnType<typeof reclaimApprovalLock>;
      try {
        result = reclaimApprovalLock(s.dir, "run-1", true);
      } finally {
        spy.mockRestore();
      }

      // `absent` would be a lie an operator or script could act on — the run
      // may well be wedged on the NEW lock. `reclaimed` would be worse: the
      // bytes actually captured were the successor's.
      expect(result.outcome).toBe("changed");
      // …and `info` still describes the lock the force decision was ABOUT.
      expect(result).toMatchObject({ holderPid: 1 });
      // The successor keeps the very file it created — same inode the
      // link-restore put back, not a rewritten copy.
      expect(fs.existsSync(lock)).toBe(true);
      expect(fs.readFileSync(lock, "utf8")).toBe(successor);
      expect(fs.existsSync(`${lock}.claim.`)).toBe(false);
    } finally {
      s.cleanup();
    }
  });

  test("a successor landing after the claim is untouched: the reclaim removes ONLY the claimed inode", () => {
    const s = store();
    try {
      s.store.create("run-1");
      const lock = path.join(s.dir, "run-1.approval.lock");
      const inspected = "2147483647:dead-holder";
      fs.writeFileSync(lock, inspected);

      // The gap the rename-to-private-claim protocol exists to close: a
      // successor takes `path` AFTER the verb has claimed and verified the
      // inspected file but before the removal lands. The spy times the
      // successor's `wx` to the removal of the PRIVATE claim — the path is
      // vacant there, so a real successor can genuinely take it in that
      // window. The assertion is that the removal still targets only the
      // claimed inode, and the successor's lock at `path` survives.
      const successor = "999999:successor-nonce";
      const realRmSync = fs.rmSync;
      const spy = spyOn(fs, "rmSync").mockImplementation(((...args: Parameters<typeof fs.rmSync>) => {
        if (String(args[0]).startsWith(`${lock}.claim.`)) {
          fs.writeFileSync(lock, successor, { flag: "wx" });
        }
        return realRmSync(...args);
      }) as typeof fs.rmSync);
      let result: ReturnType<typeof reclaimApprovalLock>;
      try {
        result = reclaimApprovalLock(s.dir, "run-1", false);
      } finally {
        spy.mockRestore();
      }

      expect(result.outcome).toBe("reclaimed");
      expect(fs.existsSync(lock)).toBe(true);
      expect(fs.readFileSync(lock, "utf8")).toBe(successor);
    } finally {
      s.cleanup();
    }
  });

  test("a fault unlinking the captured claim after a SUCCESSFUL link-restore surfaces with the path HELD (G3)", async () => {
    // The poison-and-VACANT message is the LINK fault's remedy, where the path
    // may genuinely be empty. The unlink that follows a successful link runs
    // with the replacement's inode already back at the path, so the same fault
    // there must NOT be dressed up as a restore failure inviting `fleet unlock`
    // against a live holder: it surfaces raw, the path stays HELD, and the
    // captured file is left standing for hand recovery.
    const s = store();
    try {
      s.store.create("run-1");
      const lock = path.join(s.dir, "run-1.approval.lock");
      fs.writeFileSync(lock, "2147483647:dead-holder");
      const ancient = new Date(Date.now() - 60_000);
      fs.utimesSync(lock, ancient, ancient);

      // The rename captures a REPLACEMENT's content (as in the poison tests
      // above), so the mismatch branch runs: link-restore, then the unlink of
      // the private claim — which is where the fault lands.
      const replacement = `${process.pid}:live-replacement`;
      const realRenameSync = fs.renameSync;
      const renameSpy = spyOn(fs, "renameSync").mockImplementation(((...args: Parameters<typeof fs.renameSync>) => {
        if (typeof args[0] === "string" && args[0] === lock && typeof args[1] === "string" && args[1].includes(".approval.lock.claim.")) {
          fs.rmSync(args[0], { force: true });
          fs.writeFileSync(args[0], replacement, { flag: "wx" });
        }
        return realRenameSync(...args);
      }) as typeof fs.renameSync);
      const realRmSync = fs.rmSync;
      const rmSpy = spyOn(fs, "rmSync").mockImplementation(((...args: Parameters<typeof fs.rmSync>) => {
        if (String(args[0]).includes(".approval.lock.claim.")) {
          const fault = new Error("simulated EACCES on the claim unlink") as NodeJS.ErrnoException;
          fault.code = "EACCES";
          throw fault;
        }
        return realRmSync(...args);
      }) as typeof fs.rmSync);

      let err: unknown;
      try {
        await withApprovalLock(s.dir, "run-1", () => "entered");
      } catch (e) {
        err = e;
      } finally {
        renameSpy.mockRestore();
        rmSpy.mockRestore();
      }

      // The ORIGINAL fault, verbatim — not a restore-failure wrapper, and
      // above all not a VACANT verdict about a path that is occupied.
      expect((err as Error).message).toContain("simulated EACCES on the claim unlink");
      expect((err as Error).message).not.toContain("VACANT");
      expect((err as Error).message).not.toContain("failed to restore");
      // HELD: the link already succeeded, so the replacement's lock is at the
      // path, byte for byte.
      expect(fs.readFileSync(lock, "utf8")).toBe(replacement);
      // The captured file is preserved for hand recovery, never dropped.
      const leftovers = fs.readdirSync(s.dir).filter((f) => f.includes("run-1.approval.lock.claim."));
      expect(leftovers).toHaveLength(1);
    } finally {
      s.cleanup();
    }
  });

  test("reclaimApprovalLock: a fault reading the captured claim poisons the vacant path and rethrows the ORIGINAL error (G4)", async () => {
    // The rename-away has already vacated the path when the verify read runs,
    // so a fault there must fail closed — poison, then the operator's real
    // error — rather than surfacing a bare EACCES about a file that no longer
    // exists at the path it names.
    const s = store();
    try {
      s.store.create("run-1");
      const lock = path.join(s.dir, "run-1.approval.lock");
      fs.writeFileSync(lock, "2147483647:dead-holder");
      const realReadFileSync = fs.readFileSync;
      const readSpy = spyOn(fs, "readFileSync").mockImplementation(((...args: Parameters<typeof fs.readFileSync>) => {
        if (String(args[0]).includes(".approval.lock.claim.")) {
          const fault = new Error("simulated EACCES on the claim read") as NodeJS.ErrnoException;
          fault.code = "EACCES";
          throw fault;
        }
        return realReadFileSync(...args);
      }) as typeof fs.readFileSync);
      let err: unknown;
      try {
        reclaimApprovalLock(s.dir, "run-1", true);
      } catch (e) {
        err = e;
      }
      readSpy.mockRestore();

      // The ORIGINAL error reaches the operator, not a janitorial one.
      expect((err as Error).message).toContain("simulated EACCES on the claim read");
      // The vacated path is HELD by the pid-less poison marker, which no
      // acquirer's `wx` can pass and no reclaim door will sweep.
      expect(fs.readFileSync(lock, "utf8")).toMatch(/^0:/);
      // …and the captured lock survives at its private claim name.
      const leftovers = fs.readdirSync(s.dir).filter((f) => f.includes("run-1.approval.lock.claim."));
      expect(leftovers).toHaveLength(1);
      expect(fs.readFileSync(path.join(s.dir, leftovers[0] as string), "utf8")).toBe("2147483647:dead-holder");
    } finally {
      s.cleanup();
    }
  });

  test("the lock path is built from a VALIDATED runId — no write, and no rmSync, outside dir", async () => {
    const s = store();
    try {
      // `withApprovalLock` is exported and reachable ahead of every store read,
      // so an unvalidated id both creates and later removes a file outside
      // `dir`: `../../tmp/x` is an arbitrary write-then-delete primitive.
      // T17: the canary sits at the path `join(dir, "../X")` really resolves to
      // — outside `dir` — so surviving it means something.
      const canaryName = `canary-${path.basename(s.dir)}`;
      const canary = path.join(path.dirname(s.dir), `${canaryName}.approval.lock`);
      fs.writeFileSync(canary, "must survive");
      let entered = false;
      try {
        await expect(
          withApprovalLock(s.dir, path.join("..", canaryName), () => {
            entered = true;
          }),
        ).rejects.toThrow(/invalid run id/);
        expect(entered).toBe(false);
        expect(fs.readFileSync(canary, "utf8")).toBe("must survive");
      } finally {
        fs.rmSync(canary, { force: true });
      }
      // Every id that can reach a record is still accepted — the guard is the
      // record grammar, not a new one.
      expect(await withApprovalLock(s.dir, "run-1", () => "ok")).toBe("ok");
    } finally {
      s.cleanup();
    }
  });

  test("the lock is released when the body THROWS, not only when it returns", async () => {
    const s = store();
    try {
      const lock = path.join(s.dir, "run-1.approval.lock");
      await expect(
        withApprovalLock(s.dir, "run-1", () => {
          throw new Error("body blew up");
        }),
      ).rejects.toThrow(/body blew up/);
      // A leaked lock here wedges every later verb for this run for an hour.
      expect(fs.existsSync(lock)).toBe(false);
      expect(await withApprovalLock(s.dir, "run-1", () => "reacquired")).toBe("reacquired");
    } finally {
      s.cleanup();
    }
  });

  test("the release does NOT delete a successor's lock after this holder was reclaimed", async () => {
    // The reclaim path is nonce-fenced; the release used to be an
    // unconditional `rmSync`, which made that fencing worthless. The
    // `age > LOCK_ABANDON_MS` door can reclaim a lock while its holder is still
    // inside `body()` — at which point a SECOND process legitimately owns
    // `lockPath`, and an unconditional remove here deleted ITS lock and handed
    // a third process the critical section while the second was still in it.
    //
    // The reclaim is simulated by overwriting the file mid-body, which is
    // exactly the state the real one leaves behind: same path, different
    // content. What the assertion pins is that the departing holder leaves the
    // successor's bytes intact.
    const s = store();
    try {
      const lock = path.join(s.dir, "run-1.approval.lock");
      const successor = "999999:successor-nonce";
      await withApprovalLock(s.dir, "run-1", () => {
        fs.writeFileSync(lock, successor, { mode: 0o600 });
      });
      expect(fs.existsSync(lock)).toBe(true);
      expect(fs.readFileSync(lock, "utf8")).toBe(successor);
      // And nothing is stranded off-path under a `.release.` name.
      expect(fs.readdirSync(s.dir).filter((f) => f.includes(".release."))).toEqual([]);
      fs.rmSync(lock, { force: true });
      // The ordinary case still releases — the fence must not wedge the lock.
      expect(await withApprovalLock(s.dir, "run-1", () => "ok")).toBe("ok");
      expect(fs.existsSync(lock)).toBe(false);
    } finally {
      s.cleanup();
    }
  });

  test("the release never TOUCHES a successor's lock — same inode, not merely same bytes", async () => {
    // The test above pins the successor's BYTES. That was not enough, and a
    // CodeRabbit finding on the round-6 release is what surfaced it: the old
    // release renamed `lockPath` away UNCONDITIONALLY and only then looked at
    // whose bytes it had captured, restoring them if they were not its own. So
    // the successor's file was destroyed and RECREATED even on the path that
    // "worked" — a new inode, and, for the duration of the rename plus a read,
    // NO FILE AT `lockPath` AT ALL.
    //
    // That vacancy is the actual defect. A third waiter arriving inside it
    // creates `lockPath` legitimately; the departing holder's restore then
    // fails EEXIST and it deletes the successor's captured lock, leaving the
    // successor and the third waiter both inside the critical section. The
    // interleaving needs process scheduling to reproduce, but its ROOT FACT
    // does not: identity. A release that never removes a file it does not own
    // cannot vacate the path, so pinning the inode pins the whole class.
    //
    // Verified RED against the pre-fix release: the restore rewrote the file
    // and the inode changed.
    const s = store();
    try {
      const lock = path.join(s.dir, "run-1.approval.lock");
      let successorIno = -1;
      await withApprovalLock(s.dir, "run-1", () => {
        // Exactly what a real reclaim leaves: same path, a different holder's
        // content, a NEW file. Written with `wx` after an unlink so it is
        // genuinely a distinct inode rather than an overwrite in place.
        fs.rmSync(lock, { force: true });
        fs.writeFileSync(lock, "999999:successor-nonce", { flag: "wx", mode: 0o600 });
        successorIno = fs.statSync(lock).ino;
      });
      expect(fs.existsSync(lock)).toBe(true);
      // THE assertion: the successor still holds the very file it created.
      expect(fs.statSync(lock).ino).toBe(successorIno);
      expect(fs.readdirSync(s.dir).filter((f) => f.includes(".release."))).toEqual([]);
      fs.rmSync(lock, { force: true });
    } finally {
      s.cleanup();
    }
  });

  test("a holder whose OWN lock was removed by hand releases without recreating or wedging", async () => {
    // The other half of fencing on identity: if there is nothing at `lockPath`
    // — swept by an operator, or reclaimed and then released by a successor —
    // the departing holder must do nothing at all and must not throw. A throw
    // in the `finally` would REPLACE whatever `body()` raised.
    const s = store();
    try {
      const lock = path.join(s.dir, "run-1.approval.lock");
      expect(
        await withApprovalLock(s.dir, "run-1", () => {
          fs.rmSync(lock, { force: true });
          return "body still returns";
        }),
      ).toBe("body still returns");
      expect(fs.existsSync(lock)).toBe(false);
      expect(fs.readdirSync(s.dir).filter((f) => f.includes(".release."))).toEqual([]);
      expect(await withApprovalLock(s.dir, "run-1", () => "reacquired")).toBe("reacquired");
    } finally {
      s.cleanup();
    }
  });
});

describe("truncation — the cap is the cap, suffix INCLUDED", () => {
  const suffixFor = (len: number) => `[truncated, ${len} chars total]`;

  test("a proposal at exactly MAX_PROPOSAL_CHARS is stored verbatim", async () => {
    const s = store();
    try {
      s.store.create("run-1");
      const exact = "a".repeat(MAX_PROPOSAL_CHARS);
      await requestApproval(deps(s.store), "run-1", { proposal: exact, reportId: "rv-1", headSha: SHA_A });
      expect(s.store.get("run-1").extensions?.approval?.proposal).toBe(exact);
    } finally {
      s.cleanup();
    }
  });

  test("a proposal ONE char over the cap is truncated to EXACTLY the cap, suffix and all", async () => {
    const s = store();
    try {
      s.store.create("run-1");
      const over = MAX_PROPOSAL_CHARS + 1;
      await requestApproval(deps(s.store), "run-1", {
        proposal: "a".repeat(over),
        reportId: "rv-1",
        headSha: SHA_A,
      });
      const stored = String(s.store.get("run-1").extensions?.approval?.proposal);
      // `slice(0, max) + suffix` — the obvious rewrite — overshoots by the
      // suffix's own width and quietly breaks the documented bound.
      expect(stored.length).toBe(MAX_PROPOSAL_CHARS);
      expect(stored.endsWith(suffixFor(over))).toBe(true);
      // The story's literal, bracketed and nothing else: no leading U+2026. A
      // cap is a contract and an undeclared character inside it is one the
      // consumer never agreed to.
      expect(stored).not.toContain("…");
      expect(stored.slice(0, MAX_PROPOSAL_CHARS - suffixFor(over).length)).toBe(
        "a".repeat(MAX_PROPOSAL_CHARS - suffixFor(over).length),
      );
    } finally {
      s.cleanup();
    }
  });

  test("an 8 MB proposal does not reach the record — it is capped before the write", async () => {
    const s = store();
    try {
      s.store.create("run-1");
      // The failure this bounds: `fleet status` reads this file on every
      // invocation, so an uncapped proposal is paid for on every read for the
      // rest of the run's life.
      const huge = 8 * 1024 * 1024;
      await requestApproval(deps(s.store), "run-1", { proposal: "a".repeat(huge), reportId: "rv-1", headSha: SHA_A });
      const stored = String(s.store.get("run-1").extensions?.approval?.proposal);
      expect(stored.length).toBe(MAX_PROPOSAL_CHARS);
      expect(stored).toContain(`${huge} chars total`);
      expect(fs.statSync(s.store.path("run-1")).size).toBeLessThan(2 * MAX_PROPOSAL_CHARS);
    } finally {
      s.cleanup();
    }
  });

  test("an approverId over MAX_APPROVER_ID_CHARS is capped, and the decided outcome carries the capped value", async () => {
    const s = store();
    try {
      s.store.create("run-1");
      const d = deps(s.store);
      await requestApproval(d, "run-1", req("rv-1"));
      const over = MAX_APPROVER_ID_CHARS + 1;
      const out = await submitDecision(d, "run-1", {
        decision: "approved",
        approverId: "a".repeat(over),
        reason: "r",
        reportId: "rv-1",
      });
      const suffix = suffixFor(over);
      // The OUTCOME matches the STORED bytes: a caller echoing what it got must
      // not print an id the record no longer contains.
      expect(out).toMatchObject({ outcome: "decided", approverId: expect.stringContaining(suffix) });
      const stored = String(s.store.get("run-1").extensions?.approval?.approverId);
      expect(stored.length).toBe(MAX_APPROVER_ID_CHARS);
      expect(stored.endsWith(suffix)).toBe(true);
      expect(stored).not.toContain("…");
      // The head is the id's own prefix — truncation, not replacement.
      expect(stored.slice(0, MAX_APPROVER_ID_CHARS - suffix.length)).toBe(
        "a".repeat(MAX_APPROVER_ID_CHARS - suffix.length),
      );
    } finally {
      s.cleanup();
    }
  });

  test("a reason at, and one over, MAX_REASON_CHARS", async () => {
    const s = store();
    try {
      s.store.create("run-1");
      const d = deps(s.store);
      await requestApproval(d, "run-1", req("rv-1"));
      const exact = "r".repeat(MAX_REASON_CHARS);
      await submitDecision(d, "run-1", { decision: "approved", approverId: "alice", reason: exact, reportId: "rv-1" });
      expect(s.store.get("run-1").extensions?.approval?.reason).toBe(exact);
    } finally {
      s.cleanup();
    }

    const s2 = store();
    try {
      s2.store.create("run-2");
      const d = deps(s2.store);
      await requestApproval(d, "run-2", req("rv-1"));
      const over = MAX_REASON_CHARS + 1;
      await submitDecision(d, "run-2", {
        decision: "rejected",
        approverId: "alice",
        reason: "r".repeat(over),
        reportId: "rv-1",
      });
      const stored = String(s2.store.get("run-2").extensions?.approval?.reason);
      expect(stored.length).toBe(MAX_REASON_CHARS);
      expect(stored.endsWith(suffixFor(over))).toBe(true);
      expect(stored).not.toContain("…");
    } finally {
      s2.cleanup();
    }
  });

  test("a cut landing INSIDE a surrogate pair drops the orphan — one char short, never one char corrupt", async () => {
    const s = store();
    try {
      s.store.create("run-1");
      // `slice` counts UTF-16 code units. The leading "a" makes the head budget
      // land on an odd offset, so an unguarded cut stores a LONE high
      // surrogate: not valid text, and it survives no JSON round trip intact —
      // which would make the stored proposal not even a PREFIX of the real one.
      const astral = `a${"\u{1F600}".repeat(6_000)}`;
      await requestApproval(deps(s.store), "run-1", { proposal: astral, reportId: "rv-1", headSha: SHA_A });
      const stored = String(s.store.get("run-1").extensions?.approval?.proposal);

      expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(stored)).toBe(false);
      // One code unit under the cap, because the orphan was dropped rather than
      // stored — the cap is still never EXCEEDED.
      expect(stored.length).toBe(MAX_PROPOSAL_CHARS - 1);
      expect(stored.endsWith(suffixFor(astral.length))).toBe(true);
      // …and the DROPPED half is the only loss: what remains is still a prefix
      // of the real proposal (a lone-surrogate cut is not — its replacement
      // character breaks prefix-hood), which is the property the store's
      // readers rely on. The round-trip assert is the disk-level version of
      // the same check.
      expect(astral.startsWith(stored.slice(0, stored.indexOf("[truncated")))).toBe(true);
      expect(JSON.parse(JSON.stringify(stored))).toBe(stored);
    } finally {
      s.cleanup();
    }
  });
});

describe("submitDecision — the terminal write is validated BEFORE it is taken", () => {
  const seedRun = async (s: RunRecordStore) => {
    s.create("run-1");
    await requestApproval(deps(s), "run-1", req("rv-1"));
  };

  test.each([
    ["a typo'd verdict", "aproved"],
    ["a near-miss", "approve"],
    ["an empty verdict", ""],
    ["a non-terminal state", "awaiting-approval"],
  ])("%s is refused — it would write a state nothing could ever decide or expire", async (_name, decision) => {
    const s = store();
    try {
      await seedRun(s.store);
      const before = fs.readFileSync(s.store.path("run-1"), "utf8");
      await expect(
        submitDecision(deps(s.store), "run-1", {
          decision: decision as never,
          approverId: "alice",
          reason: "r",
          reportId: "rv-1",
        }),
      ).rejects.toThrow(/must be "approved" or "rejected"/);
      expect(fs.readFileSync(s.store.path("run-1"), "utf8")).toBe(before);
    } finally {
      s.cleanup();
    }
  });

  test.each([[""], [" "], ["\t\n"]])(
    "an empty or whitespace approverId (%j) is refused — DF5.2 rejects it forever",
    async (approverId) => {
      const s = store();
      try {
        await seedRun(s.store);
        const before = fs.readFileSync(s.store.path("run-1"), "utf8");
        await expect(
          submitDecision(deps(s.store), "run-1", {
            decision: "approved",
            approverId,
            reason: "r",
            reportId: "rv-1",
          }),
        ).rejects.toThrow(/requires an approverId — DF5\.2 refuses/);
        // The record is immutable once terminal, so a bad value here is not a
        // bad write — it is a dead run.
        expect(fs.readFileSync(s.store.path("run-1"), "utf8")).toBe(before);
      } finally {
        s.cleanup();
      }
    },
  );

  test("the timeout actor is RESERVED — a human decision may not be filed as a machine timeout", async () => {
    const s = store();
    try {
      await seedRun(s.store);
      // INV-APPROVE-4. `TIMEOUT_APPROVER_ID` is not otherwise excluded from the
      // allowlist, so without this an entry minted under that id lets somebody
      // who answered make it look like nobody did.
      await expect(
        submitDecision(deps(s.store), "run-1", {
          decision: "rejected",
          approverId: TIMEOUT_APPROVER_ID,
          reason: "r",
          reportId: "rv-1",
        }),
      ).rejects.toThrow(/reserved/);
      expect(s.store.get("run-1").extensions?.approval?.state).toBe("awaiting-approval");
    } finally {
      s.cleanup();
    }
  });

  test("a decision against a run that DOES NOT EXIST fails loudly, naming the run", async () => {
    const s = store();
    try {
      // A typo'd run id is the most ordinary operator error on this verb.
      // `submitDecision` reads through `readApproval`, which does NOT catch
      // ENOENT (unlike `readApprovalIfPresent`), so this is a throw and not a
      // `not-decidable` — pinned so the two readers cannot silently converge.
      //
      // D7 resolved this as CORRECT rather than changing it, and the reasoning
      // is on `readApproval` in the source. The short version: this is the
      // LIBRARY layer's backstop, and the operator never meets it — the verb
      // block's `assertRunExists` classifies a missing run as exit 4 first,
      // which `tests/fleet/gate-verbs.test.ts`'s D7 case now pins out of
      // process. Loosening this to `not-decidable` would map a typo to exit 5
      // ("a guard fired") instead of 4 ("that run does not exist").
      await expect(
        submitDecision(deps(s.store), "run-typo", {
          decision: "approved",
          approverId: "alice",
          reason: "r",
          reportId: "rv-1",
        }),
      ).rejects.toThrow(/run-typo/);
      // The lock it took on the way in is released, not leaked.
      expect(fs.existsSync(path.join(s.dir, "run-typo.approval.lock"))).toBe(false);
    } finally {
      s.cleanup();
    }
  });

  test("a reportId is TRIMMED on BOTH sides of the compare-and-set", async () => {
    const s = store();
    try {
      s.store.create("run-1");
      const d = deps(s.store);
      // A `$(...)` capture or an operator's copy-paste arrives with a trailing
      // newline. Binding it untrimmed makes the record undecidable forever;
      // trimming only one side answers `report-changed` against the id it IS.
      await requestApproval(d, "run-1", { proposal: "p", reportId: " rv-1\n", headSha: ` ${SHA_A}\n` });
      const ext = s.store.get("run-1").extensions?.approval;
      expect(ext?.reportId).toBe("rv-1");
      expect(ext?.headSha).toBe(SHA_A);

      const out = await submitDecision(d, "run-1", {
        decision: "approved",
        approverId: "alice",
        reason: "ok",
        reportId: "rv-1\n",
      });
      expect(out.outcome).toBe("decided");
    } finally {
      s.cleanup();
    }
  });
});

describe("the rebind history is an AUDIT TRAIL, not an append log", () => {
  test("an IDENTICAL rebind appends nothing — the live id is never also 'superseded'", async () => {
    const s = store();
    try {
      s.store.create("run-1");
      const d = deps(s.store);
      await requestApproval(d, "run-1", req("rv-1"));
      const second = await requestApproval(d, "run-1", req("rv-1"));
      const third = await requestApproval(d, "run-1", req("rv-1"));

      expect(second).toEqual({ outcome: "rebound", supersededReportId: "rv-1" });
      const ext = s.store.get("run-1").extensions?.approval;
      // A record claiming one report both CURRENT and SUPERSEDED answers "was
      // this decided against a live binding?" both ways.
      expect(ext?.reportId).toBe("rv-1");
      expect(ext?.supersededReportIds).toEqual([]);
      expect(third).toEqual({ outcome: "rebound", supersededReportId: "rv-1" });
    } finally {
      s.cleanup();
    }
  });

  test("a report RE-PRESENTED after being displaced is REFUSED (approval-report-stale), leaving the record alone", async () => {
    // R1: re-presenting a superseded reportId is the stale-TOCTOU footgun — a
    // reverify worker that read the record outside the lock and lost the race
    // presents exactly this. Re-binding it would move the live approval back
    // onto a report the record itself says is displaced, so it refuses instead;
    // the history stays append-only and nothing is un-displaced. (A→B→C, a
    // third never-bound id, remains legal and is pinned by "no finish carries a
    // decision against a reportId in NEITHER reportId nor supersededReportIds".)
    const s = store();
    try {
      s.store.create("run-1");
      const d = deps(s.store);
      await requestApproval(d, "run-1", req("rv-1"));
      await requestApproval(d, "run-1", req("rv-2", SHA_B)); // displaces rv-1
      const before = fs.readFileSync(s.store.path("run-1"), "utf8");

      // rv-1 AGAIN: dead, and the refusal names both the rule and the live id.
      await expect(requestApproval(d, "run-1", req("rv-1"))).rejects.toThrow(
        /already recorded as superseded \(approval-report-stale\)[\s\S]*the live binding is rv-2/,
      );

      // Refused ⇒ byte-identical, like every other refusal in this file: the
      // live binding, the history and the window are exactly as they were.
      expect(fs.readFileSync(s.store.path("run-1"), "utf8")).toBe(before);
      const ext = s.store.get("run-1").extensions?.approval;
      expect(ext?.reportId).toBe("rv-2");
      expect(ext?.supersededReportIds).toEqual(["rv-1"]);
      expect(ext?.state).toBe("awaiting-approval");
    } finally {
      s.cleanup();
    }
  });

  test("an empty bound id is never appended — an entry naming no report is not history", async () => {
    const s = store();
    try {
      s.store.create("run-1");
      // The shape a hand-edited or partially-written record leaves behind.
      s.store.set("run-1", {
        extensions: { approval: { state: "awaiting-approval", proposal: "p", reportId: "", headSha: SHA_A } },
      });
      const out = await requestApproval(deps(s.store), "run-1", req("rv-9"));
      // The rebind ANSWERS with the id it displaced — here the empty string —
      // so the outcome itself is the assertion that the skip was deliberate
      // rather than the append never having been reached.
      expect(out).toEqual({ outcome: "rebound", supersededReportId: "" });
      expect(s.store.get("run-1").extensions?.approval?.supersededReportIds).toEqual([]);
    } finally {
      s.cleanup();
    }
  });

  test("a rebind RESTAMPS expiresAt — the record never contradicts its own two timestamps", async () => {
    const s = store();
    try {
      s.store.create("run-1");
      const t0 = new Date("2026-08-28T12:00:00.000Z");
      const t1 = new Date("2026-08-29T11:59:00.000Z");
      // 23h59m into the 24h default window: still open, so this really is the
      // REBIND arm and not the already-decided one.
      await requestApproval(deps(s.store, { now: () => t0 }), "run-1", req("rv-1"));
      await requestApproval(deps(s.store, { now: () => t1 }), "run-1", req("rv-2", SHA_B));

      const ext = s.store.get("run-1").extensions?.approval;
      // `set()` merges field by field, so a rebind that refreshed `requestedAt`
      // and left `expiresAt` behind inherits the ORIGINAL window: a report
      // bound at T+23h59m would time out a minute later, against a record whose
      // own stamps say it was requested after it expired.
      expect(ext?.requestedAt).toBe(t1.toISOString());
      expect(ext?.expiresAt).toBe(new Date(t1.getTime() + DEFAULT_TIMEOUT_MS).toISOString());
      expect(Date.parse(String(ext?.expiresAt))).toBeGreaterThan(Date.parse(String(ext?.requestedAt)));
    } finally {
      s.cleanup();
    }
  });

  test("a PRE-DF3.4 record carrying the singular scalar reads, rebinds and decides", async () => {
    const s = store();
    try {
      s.store.create("run-1");
      // What the older build left on disk. The scalar is retired, so it can no
      // longer be read as a field, written, or cleared — the store folds it
      // into the array at the HEAD on the next write. A gate that could not
      // rebind past one would strand every run paused by the previous build.
      const raw = JSON.parse(fs.readFileSync(s.store.path("run-1"), "utf8")) as Record<string, unknown>;
      raw.extensions = {
        approval: {
          schemaVersion: 1,
          state: "awaiting-approval",
          proposal: "p",
          reportId: "rv-2",
          headSha: SHA_A,
          expiresAt: "2099-01-01T00:00:00.000Z",
          supersededReportId: "rv-1",
        },
      };
      fs.writeFileSync(s.store.path("run-1"), JSON.stringify(raw), { mode: 0o600 });

      const d = deps(s.store);
      expect(await requestApproval(d, "run-1", req("rv-3"))).toEqual({ outcome: "rebound", supersededReportId: "rv-2" });
      const ext = s.store.get("run-1").extensions?.approval;
      // Folded at the head (it predates everything the array writer appended)
      // and never lost — a decision may be checked against it.
      expect(ext?.supersededReportIds).toEqual(["rv-1", "rv-2"]);
      expect(ext).not.toHaveProperty("supersededReportId");
      expect(ext?.schemaVersion).toBe(2);

      const out = await submitDecision(d, "run-1", {
        decision: "approved",
        approverId: "alice",
        reason: "ok",
        reportId: "rv-3",
      });
      expect(out).toMatchObject({ outcome: "decided", state: "approved" });
      const decided = s.store.get("run-1").extensions?.approval;
      expect(decided?.supersededReportIds).toEqual(["rv-1", "rv-2"]);
    } finally {
      s.cleanup();
    }
  });

  test("rebinds from separate PROCESSES lose no displaced id", async () => {
    const s = store();
    // The children PARK on the gate file until it exists, so an expect that
    // fails before `fs.writeFileSync(gate, "")` runs would otherwise leave four
    // bun processes spinning forever past the end of the suite. Kill whatever
    // was spawned, whatever happened.
    const children: ReturnType<typeof Bun.spawn>[] = [];
    try {
      s.store.create("run-1");
      await requestApproval(deps(s.store), "run-1", req("rv-1"));

      // The read-modify-write the lock exists for. `validateExtensions`
      // REPLACES a field's value and has no append semantics, so two concurrent
      // rebinds each read [] and write [rv-1] — one displaced id is lost and
      // the DoD ("no decision names a reportId absent from both fields") is
      // broken. In ONE process the two bodies are synchronous and cannot
      // interleave, so this is only provable across processes.
      //
      // SEAM NOTE, stated rather than worked around: the interleaving itself
      // CANNOT be made deterministic. The critical section inside `pauseRun`
      // is fully synchronous (get → decide → set, no await), so there is no
      // deps hook at which a yield could be injected without adding a
      // production seam that exists only for tests. What CAN be pinned is
      // everything around it:
      //
      //  - START SYNCHRONY: each child writes a ready file and then parks on
      //    a gate file; the parent releases the gate only after EVERY ready
      //    file exists — not a fixed `Bun.sleep(400)` startup guess that a
      //    slow CI box can overrun.
      //  - COLLISION SURFACE: FOUR racers, not two, so a broken lock has 4!
      //    orderings in which to lose an id instead of 2.
      //
      // The property asserted is the one that matters: every id this run was
      // ever bound to is recoverable afterwards.
      const gate = path.join(s.dir, "go");
      const racers = [
        ["rv-2", SHA_B],
        ["rv-3", SHA_A],
        ["rv-4", SHA_B],
        ["rv-5", SHA_A],
      ] as const;
      const child = (reportId: string, headSha: string) => {
        const ready = path.join(s.dir, `ready-${reportId}`);
        return Bun.spawn(
          [
            "bun",
            "-e",
            `const { requestApproval } = await import(${JSON.stringify(path.join(REPO_SRC, "fleet", "approval-gate.ts"))});
             const { RunRecordStore } = await import(${JSON.stringify(path.join(REPO_SRC, "providers", "run-record.ts"))});
             const fs = await import("node:fs");
             fs.writeFileSync(${JSON.stringify(ready)}, "");
             while (!fs.existsSync(${JSON.stringify(gate)})) await Bun.sleep(2);
             const store = new RunRecordStore({ dir: ${JSON.stringify(s.dir)} });
             await requestApproval({ store }, "run-1", { proposal: "p", reportId: ${JSON.stringify(reportId)}, headSha: ${JSON.stringify(headSha)} });`,
          ],
          { stdout: "pipe", stderr: "pipe" },
        );
      };
      const spawned = racers.map(([reportId, headSha]) => child(reportId, headSha));
      children.push(...spawned);
      for (const [reportId] of racers) {
        const ready = path.join(s.dir, `ready-${reportId}`);
        // 1000 × 5ms = 5s of budget per child. A cold bun process can take
        // several seconds to import the store; past this the failure is the
        // `expect` below, which names which child never readied.
        for (let i = 0; i < 1000 && !fs.existsSync(ready); i++) await Bun.sleep(5);
        expect(fs.existsSync(ready)).toBe(true);
      }
      fs.writeFileSync(gate, "");
      const results = await Promise.all(
        spawned.map(async (c) => ({ code: await c.exited, err: await new Response(c.stderr).text() })),
      );
      const failed = results.filter((r) => r.code !== 0);
      if (failed.length > 0) throw new Error(`children failed:\n${failed.map((r) => r.err).join("\n")}`);

      const ext = s.store.get("run-1").extensions?.approval;
      const known = new Set([String(ext?.reportId), ...((ext?.supersededReportIds as string[]) ?? [])]);
      // Whichever won the lock, all five ids are still recoverable.
      expect([...known].sort()).toEqual(["rv-1", "rv-2", "rv-3", "rv-4", "rv-5"]);
      expect(ext?.supersededReportIds).toHaveLength(4);
    } finally {
      for (const c of children) c.kill();
      // T18: the children are dead BEFORE their runs directory is removed — a
      // child still holding an open fd (or still polling) under a deleted dir
      // turns a cleanup into a cross-test race.
      await Promise.all(children.map((c) => c.exited));
      s.cleanup();
    }
  }, 60_000);
});

/**
 * The resume arm's byte-identity, the state it refuses to walk over, and the
 * hand-edit it must not wedge on. Every refusal here is byte-identical, like
 * every other refusal in this file — these three are the ones a plausible
 * implementation gets wrong while every outcome assertion stays green.
 */
describe("the resume arm compares the record's OWN fields, and refuses what it cannot honour", () => {
  test("a resume whose re-presented headSha DIFFERS from the stored one is refused (approval-report-mismatch, R2)", async () => {
    const s = store();
    try {
      s.store.create("run-1");
      // Stranded against commit B. Re-presenting the SAME reportId with commit
      // A's sha would promote an approval bound to B onto code from A, with no
      // rebind in between to record the move — the resume is the one arm that
      // promotes whatever the record was paused against.
      seedPausing(s.store, "run-1", "rv-1", { headSha: SHA_B });
      const before = fs.readFileSync(s.store.path("run-1"), "utf8");
      await expect(requestApproval(deps(s.store), "run-1", req("rv-1"))).rejects.toThrow(
        /refusing to resume run-1[\s\S]*approval-report-mismatch[\s\S]*re-run the verify for the original commit/,
      );
      // Untouched, and still `pausing`: recoverable, never promoted over
      // different code.
      expect(fs.readFileSync(s.store.path("run-1"), "utf8")).toBe(before);
      expect(s.store.get("run-1").extensions?.approval?.state).toBe("pausing");
    } finally {
      s.cleanup();
    }
  });

  test("an UNRECOGNIZED state refuses the pause and the record is byte-identical afterwards (G6)", async () => {
    const s = store();
    try {
      s.store.create("run-1");
      // A hand-edited or half-written record. The old fall-through treated any
      // unknown state as "no approval yet": it minted a fresh window and reset
      // the audit trail. Fail closed instead, naming the state it found.
      s.store.set("run-1", {
        extensions: { approval: { state: "paused-by-hand", proposal: "p", reportId: "rv-1", headSha: SHA_A } },
      });
      const before = fs.readFileSync(s.store.path("run-1"), "utf8");
      await expect(requestApproval(deps(s.store), "run-1", req("rv-9"))).rejects.toThrow(
        /is in state "paused-by-hand"[\s\S]*\(approval-state-unrecognized\)[\s\S]*supersededReportIds history/,
      );
      expect(fs.readFileSync(s.store.path("run-1"), "utf8")).toBe(before);
    } finally {
      s.cleanup();
    }
  });

  test("a stored reportId carrying stray whitespace still matches its own report on resume (G13)", async () => {
    const s = store();
    try {
      s.store.create("run-1");
      // The hand-edit shape: an id written with a stray space and newline. Both
      // sides are TRIMMED before the comparison, so the run resumes instead of
      // wedging as `pause-in-progress` forever — an id that cannot be matched
      // to its own report is a run nobody can ever promote.
      seedPausing(s.store, "run-1", "  rv-1\n");
      const log: string[] = [];
      const out = await requestApproval(
        deps(s.store, { teardown: recordingTeardown(s.store, log) }),
        "run-1",
        req("rv-1"),
      );
      expect(out).toEqual({ outcome: "requested" });
      expect(log).toEqual(["teardown:run-1:pausing"]);
      expect(s.store.get("run-1").extensions?.approval?.state).toBe("awaiting-approval");
    } finally {
      s.cleanup();
    }
  });
});

describe("timeouts and expiry — the arms a reader actually hands in", () => {
  test("expiredState answers undefined for the shapes `fleet status` hands it on an ORDINARY run", () => {
    // Both are "this run has no approval namespace": a run that never reached
    // the gate, and a namespace whose `state` was never written. Neither is a
    // state, and neither may be rendered as one.
    expect(expiredState(undefined, new Date())).toBeUndefined();
    expect(expiredState({ schemaVersion: 2 }, new Date())).toBeUndefined();
    expect(expiredState({ schemaVersion: 2, state: "" }, new Date())).toBeUndefined();
    expect(expiredState({ schemaVersion: 2, state: "", expiresAt: "2020-01-01T00:00:00.000Z" }, new Date())).toBeUndefined();
  });

  test("an absurd timeoutMs is CLAMPED to the ceiling, never a bare RangeError", async () => {
    const s = store();
    try {
      s.store.create("run-1");
      const now = new Date("2026-08-28T12:00:00.000Z");
      // `Number.isFinite(9e15)` is TRUE, so an unclamped upper bound reaches
      // `new Date(at + ms)` and throws a RangeError naming neither the run nor
      // the field.
      await requestApproval(deps(s.store, { now: () => now, timeoutMs: 9e15 }), "run-1", req("rv-1"));
      const expiresAt = String(s.store.get("run-1").extensions?.approval?.expiresAt);
      expect(Date.parse(expiresAt) - now.getTime()).toBe(MAX_TIMEOUT_MS);
    } finally {
      s.cleanup();
    }
  });

  test.each([[Number.NaN], [Number.POSITIVE_INFINITY]])(
    "a non-finite timeoutMs (%p) falls back to the default rather than poisoning the stamp",
    async (timeoutMs) => {
      const s = store();
      try {
        s.store.create("run-1");
        const now = new Date("2026-08-28T12:00:00.000Z");
        await requestApproval(deps(s.store, { now: () => now, timeoutMs }), "run-1", req("rv-1"));
        const expiresAt = String(s.store.get("run-1").extensions?.approval?.expiresAt);
        expect(Date.parse(expiresAt) - now.getTime()).toBe(DEFAULT_TIMEOUT_MS);
      } finally {
        s.cleanup();
      }
    },
  );

  test("awaitDecision returns the EXPIRY as a decision, anchored at expiresAt, without writing", async () => {
    const s = store();
    try {
      s.store.create("run-1");
      const requestedAt = new Date("2026-08-28T12:00:00.000Z");
      await requestApproval(
        deps(s.store, { now: () => requestedAt, timeoutMs: MIN_TIMEOUT_MS }),
        "run-1",
        req("rv-1"),
      );
      const expiresAt = String(s.store.get("run-1").extensions?.approval?.expiresAt);
      const before = fs.readFileSync(s.store.path("run-1"), "utf8");

      // There is no daemon, so a run that expires mid-wait is still
      // `awaiting-approval` on disk. Reading the RAW state meant polling the
      // whole window and then answering `null` — indistinguishable to the
      // caller from "nobody has answered yet", when the answer was available
      // the instant `expiresAt` passed.
      const decision = await awaitDecision(
        deps(s.store, { now: () => new Date("2026-08-29T12:00:00.000Z") }),
        "run-1",
        { pollMs: 5, waitMs: 5_000 },
      );
      expect(decision).toEqual({
        state: "timed-out",
        approverId: TIMEOUT_APPROVER_ID,
        // The expiry INSTANT, not the moment this reader noticed: two readers
        // who noticed at different times must not report two decision times.
        decidedAt: expiresAt,
        reason: expect.stringContaining("approval window"),
      });
      // Derived, not persisted — `awaitDecision` may hold a create:false store.
      expect(fs.readFileSync(s.store.path("run-1"), "utf8")).toBe(before);
    } finally {
      s.cleanup();
    }
  });

  test("a PERSISTED timeout and a DERIVED one report the same reason and the same decidedAt instant", async () => {
    const s = store();
    try {
      s.store.create("run-1");
      const at = new Date("2026-08-28T12:00:00.000Z");
      const later = new Date("2026-08-29T12:00:00.000Z");
      await requestApproval(deps(s.store, { now: () => at, timeoutMs: MIN_TIMEOUT_MS }), "run-1", req("rv-1"));
      const derived = await awaitDecision(deps(s.store, { now: () => later }), "run-1", { pollMs: 5, waitMs: 100 });
      await sweepExpired(deps(s.store, { now: () => later }), "run-1");
      const persisted = s.store.get("run-1").extensions?.approval;

      // ONE literal for both, so the sweep and the derived answer can never
      // disagree about why a run stopped — and one anchor (`expiresAt`) for
      // WHEN: a persisted notice-time stamp would contradict the answer a
      // reader derived from the same record a minute earlier.
      expect(derived?.reason).toBe(String(persisted?.reason));
      expect(derived?.approverId).toBe(String(persisted?.approverId));
      expect(String(persisted?.decidedAt)).toBe(String(derived?.decidedAt));
      expect(String(persisted?.decidedAt)).toBe(String(persisted?.expiresAt));
    } finally {
      s.cleanup();
    }
  });
});

describe("INV-APPROVE-6 — the guards' third conjunct, in the OTHER direction", () => {
  test("a CLOSED record with a box and NO keyHash still pauses — closedAt settles the claim", async () => {
    const s = store();
    try {
      s.store.create("run-1");
      s.store.set("run-1", { vmName: "run-1" });
      s.store.close("run-1");
      // Dropping `rec.closedAt === undefined` from the R5-C guard makes every
      // already-closed run permanently unpausable, with a stranded `pausing`
      // extension and no route forward — the reverify runner's ordinary case,
      // because the box dies before the host verdict.
      const out = await requestApproval(deps(s.store), "run-1", req("rv-1"));
      expect(out).toEqual({ outcome: "requested" });
      expect(s.store.get("run-1").extensions?.approval?.state).toBe("awaiting-approval");
    } finally {
      s.cleanup();
    }
  });

  test("a record with NO box promotes with no teardown seam — there is nothing to destroy", async () => {
    const s = store();
    try {
      s.store.create("run-1");
      // The negative control for the seam guard: absent `teardown` is only a
      // refusal when the record itself contradicts "the box is already gone".
      const out = await requestApproval(deps(s.store), "run-1", req("rv-1"));
      expect(out).toEqual({ outcome: "requested" });
      expect(s.store.get("run-1").extensions?.approval?.state).toBe("awaiting-approval");
    } finally {
      s.cleanup();
    }
  });
});

describe("A9 — INV-APPROVE-6 on EVERY route to the decidable window (rebind and decide)", () => {
  // The promote tail is pinned in the describes above. The two later routes
  // are pinned here: a record that picks up live infrastructure AFTER its
  // window opened must refuse to re-bind or to take a decision, because both
  // would authorize a PR sitting over a live, billing box.
  const BOX = { vmName: "qds-box-1", keyHash: "h".repeat(64) };

  const seedAwaiting = async (s: RunRecordStore) => {
    s.create("run-1");
    // Seeded through the gate with NO core infrastructure fields, so the pause
    // and promote tail run clean; the box arrives on the record afterwards —
    // the hand-edit / external-teardown shape the guard exists for.
    await requestApproval(deps(s), "run-1", req("rv-1"));
  };

  test("a rebind against an OPEN record naming a box refuses, and the OLD window stands", async () => {
    const s = store();
    try {
      await seedAwaiting(s.store);
      s.store.set("run-1", BOX);
      const before = fs.readFileSync(s.store.path("run-1"), "utf8");
      await expect(requestApproval(deps(s.store), "run-1", req("rv-2", SHA_B))).rejects.toThrow(
        /refusing to rebind run-1: its record is open and still names box qds-box-1 and its minted key[\s\S]*run `fleet teardown run-1` first/,
      );
      // Refused BEFORE the restamp: the previous window is byte-identical, so
      // the run keeps the deadline it had rather than a fresh one over the box.
      expect(fs.readFileSync(s.store.path("run-1"), "utf8")).toBe(before);
      expect(s.store.get("run-1").extensions?.approval?.reportId).toBe("rv-1");
    } finally {
      s.cleanup();
    }
  });

  test("a rebind against an OPEN record naming only a keyHash refuses — a minted key may still be live", async () => {
    const s = store();
    try {
      await seedAwaiting(s.store);
      s.store.set("run-1", { vmName: undefined, keyHash: "k".repeat(64) });
      await expect(requestApproval(deps(s.store), "run-1", req("rv-2", SHA_B))).rejects.toThrow(
        /still names a minted key[\s\S]*fleet teardown run-1/,
      );
    } finally {
      s.cleanup();
    }
  });

  test("the SAME record with closedAt set REBINDS — closedAt settles 'already gone'", async () => {
    const s = store();
    try {
      await seedAwaiting(s.store);
      s.store.set("run-1", BOX);
      s.store.close("run-1");
      const out = await requestApproval(deps(s.store), "run-1", req("rv-2", SHA_B));
      expect(out).toEqual({ outcome: "rebound", supersededReportId: "rv-1" });
      expect(s.store.get("run-1").extensions?.approval?.reportId).toBe("rv-2");
    } finally {
      s.cleanup();
    }
  });

  test("a DECISION against an OPEN record naming a box refuses — the decision IS the authorization", async () => {
    const s = store();
    try {
      await seedAwaiting(s.store);
      s.store.set("run-1", BOX);
      const before = fs.readFileSync(s.store.path("run-1"), "utf8");
      await expect(
        submitDecision(deps(s.store), "run-1", {
          decision: "approved",
          approverId: "alice",
          reason: "r",
          reportId: "rv-1",
        }),
      ).rejects.toThrow(/refusing to decide run-1[\s\S]*fleet teardown run-1/);
      // Refused ⇒ still awaiting, byte-identical — no decision was recorded.
      expect(fs.readFileSync(s.store.path("run-1"), "utf8")).toBe(before);
      expect(s.store.get("run-1").extensions?.approval?.state).toBe("awaiting-approval");
    } finally {
      s.cleanup();
    }
  });

  test("a DECISION against the SAME record closed proceeds", async () => {
    const s = store();
    try {
      await seedAwaiting(s.store);
      s.store.set("run-1", BOX);
      s.store.close("run-1");
      const out = await submitDecision(deps(s.store), "run-1", {
        decision: "approved",
        approverId: "alice",
        reason: "r",
        reportId: "rv-1",
      });
      expect(out).toMatchObject({ outcome: "decided", state: "approved" });
      expect(s.store.get("run-1").extensions?.approval?.state).toBe("approved");
    } finally {
      s.cleanup();
    }
  });
});

describe("A1 — the approval extension carries the run's dispatch id", () => {
  test("a record with a dispatch id stamps extensions.approval.requestId on every write", async () => {
    const s = store();
    try {
      s.store.create("run-1");
      const rid = "11111111-2222-4333-8444-555555555555";
      s.store.set("run-1", { requestId: rid });
      const d = deps(s.store);
      await requestApproval(d, "run-1", req("rv-1"));
      // The REGISTER write (fresh pause).
      expect(s.store.get("run-1").extensions?.approval?.requestId).toBe(rid);

      // The REBIND write: the join key stays current, not stale from the first.
      const rid2 = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
      s.store.set("run-1", { requestId: rid2 });
      await requestApproval(d, "run-1", req("rv-2", SHA_B));
      expect(s.store.get("run-1").extensions?.approval?.requestId).toBe(rid2);
    } finally {
      s.cleanup();
    }
  });

  test("a record with no dispatch id gets NO invented requestId on the extension", async () => {
    const s = store();
    try {
      s.store.create("run-1");
      await requestApproval(deps(s.store), "run-1", req("rv-1"));
      // OMITTED, never minted: a random id on the extension would look joinable
      // and join to nothing — the same lie the log line avoids with "unknown".
      expect(s.store.get("run-1").extensions?.approval).not.toHaveProperty("requestId");
    } finally {
      s.cleanup();
    }
  });
});

/**
 * The `pause` gate event (DF3.4 deferred item D1).
 *
 * `gateEvent`'s union in `scripts/fleet.ts` has declared `"pause"` since the
 * story shipped and NOTHING emitted it: the CLI has no `requestApproval` call
 * site (the pause happens inside reverify), so the producer had to be this
 * module. DF5.3 is specified to join approvals across every gate event, and the
 * pause is the one event its E2E slice is built around.
 *
 * Every case here reads the REAL sink through `setLogSink` — the same route
 * `tests/fleet/gate-verbs.test.ts` uses for the decision events — so what is
 * asserted is the line the fleet actually writes, not a shape a helper invented.
 */
describe("D1 — the pause gate event", () => {
  /** Capture every line one call emits, restoring the sink whatever happens. */
  async function linesFrom(fn: () => Promise<unknown>): Promise<{ lines: LogEntry[]; threw: unknown }> {
    const lines: LogEntry[] = [];
    const restore = setLogSink((e) => void lines.push(e));
    let threw: unknown;
    try {
      await fn();
    } catch (e) {
      threw = e;
    } finally {
      restore();
    }
    // The store emits its own `run-record.*` lines through the same sink; the
    // gate's are the ones this describe is about.
    return { lines: lines.filter((e) => e.event === "pause"), threw };
  }

  /** A run record as DISPATCH leaves it: carrying its correlation id. */
  function dispatched(s: RunRecordStore, runId: string, requestId = "11111111-2222-4333-8444-555555555555"): string {
    s.create(runId);
    s.set(runId, { requestId });
    return requestId;
  }

  // The CLOSED key set of an ERROR pause line — one literal, three consumers.
  // Pinned because `toMatchObject` tolerates EXTRA keys: an added
  // `error: err.message` field would pass every shape assertion while quoting
  // operator input (vmName, bundleDir, record fields) onto the shared sink —
  // which is exactly why `emitPause` carries no error text. Sorted, and
  // compared against a sorted key list. The success line's own closed set (the
  // fresh-pause and no-secrets tests) is this same list, because no error path
  // here reaches `teardown_at_pause_ms` and the success line below runs with
  // no teardown seam either — the two shapes ARE one set today; if a future
  // error path ever times a teardown, that is a new entry here and a
  // deliberate one.
  const ERROR_LINE_KEYS = [
    "agentId",
    "dispatchRequestId",
    "duration",
    "durationMs",
    "event",
    "operation",
    "outcome",
    "record_write_ms",
    "requestId",
    "runId",
    "state",
    "status",
    "timestamp",
  ];

  test("a fresh pause emits exactly one line with the contract's fields", async () => {
    const s = store();
    try {
      const rid = dispatched(s.store, "run-1");
      const t0 = Date.now();
      const { lines } = await linesFrom(() => requestApproval(deps(s.store), "run-1", req("rv-1")));
      const elapsed = Date.now() - t0;

      // EXACTLY one. A second producer added later (or an emit moved out of the
      // `finally` into each return) shows up here before it shows up in a
      // dashboard as a double-counted pause.
      expect(lines).toHaveLength(1);
      const line = lines[0] as LogEntry;
      expect(line).toMatchObject({
        operation: "fleet.pause",
        event: "pause",
        runId: "run-1",
        state: "awaiting-approval",
        outcome: "requested",
        status: "ok",
        agentId: null,
      });
      // THE JOIN. `requestId` is the emitting context's own id, which for a
      // library call with no invocation of its own is the run's dispatch id;
      // `dispatchRequestId` states the same fact under the key every gate event
      // carries it under, and is what DF5.3 joins across processes.
      expect(line.requestId).toBe(rid);
      expect(line.dispatchRequestId).toBe(rid);
      expect(typeof line.durationMs).toBe("number");
      // Anchored against REAL elapsed time, the same way the
      // `teardown_at_pause_ms` pin below is: the duration is measured from
      // `requestApproval`'s entry to its `finally`, so it sits inside the
      // window this test measured around the whole call. Comparing
      // `duration` to `durationMs` alone would be near-tautology — both are
      // emitted from the same local.
      expect(Number(line.durationMs)).toBeGreaterThanOrEqual(0);
      expect(Number(line.durationMs)).toBeLessThanOrEqual(elapsed);
      expect(typeof line.record_write_ms).toBe("number");
      expect(Number(line.record_write_ms)).toBeGreaterThanOrEqual(0);
    } finally {
      s.cleanup();
    }
  });

  test("teardown_at_pause_ms is ABSENT when no teardown ran, and present when one did", async () => {
    const s = store();
    try {
      dispatched(s.store, "run-1");
      const { lines: noSeam } = await linesFrom(() => requestApproval(deps(s.store), "run-1", req("rv-1")));
      expect(noSeam).toHaveLength(1);
      // Absent, NOT zero. This is the shipped reverify path (the box is already
      // gone — see deferred item D8), and `0` would be indistinguishable from a
      // teardown that ran instantaneously.
      expect(Object.keys(noSeam[0] as LogEntry)).not.toContain("teardown_at_pause_ms");

      dispatched(s.store, "run-2");
      const { lines: seam } = await linesFrom(() =>
        requestApproval(
          deps(s.store, {
            teardown: async () => {
              await Bun.sleep(12);
            },
          }),
          "run-2",
          req("rv-2"),
        ),
      );
      expect(seam).toHaveLength(1);
      expect(Object.keys(seam[0] as LogEntry)).toContain("teardown_at_pause_ms");
      // The real elapsed time of the real seam, not a constant.
      expect(Number(seam[0]?.teardown_at_pause_ms)).toBeGreaterThanOrEqual(10);
    } finally {
      s.cleanup();
    }
  });

  test("a throw still emits — status error, and the RECOVERABLE state the record is left in", async () => {
    const s = store();
    try {
      dispatched(s.store, "run-1");
      const { lines, threw } = await linesFrom(() =>
        requestApproval(
          deps(s.store, {
            teardown: async () => {
              throw new Error("box destroy failed");
            },
          }),
          "run-1",
          req("rv-1"),
        ),
      );
      expect((threw as Error).message).toMatch(/box destroy failed/);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({ event: "pause", outcome: "error", status: "error", state: "pausing" });
      expect(Object.keys(lines[0] as LogEntry).sort()).toEqual(ERROR_LINE_KEYS);
      // `pausing` is not a guess: it is what is on disk, which is the whole
      // point of registering before teardown.
      expect(s.store.get("run-1").extensions?.approval?.state).toBe("pausing");
    } finally {
      s.cleanup();
    }
  });

  test("the INV-APPROVE-6 refusal is reported as an event, not swallowed", async () => {
    const s = store();
    try {
      dispatched(s.store, "run-1");
      // An OPEN record still naming a box, with no teardown seam: the gate
      // refuses to promote. An operator correlating a run that never reached
      // `awaiting-approval` needs this line to exist.
      s.store.set("run-1", { vmName: "qds-box-1", keyHash: "hash-1" });
      const { lines, threw } = await linesFrom(() => requestApproval(deps(s.store), "run-1", req("rv-1")));
      expect((threw as Error).message).toMatch(/no teardown seam/);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({ event: "pause", outcome: "error", status: "error", state: "pausing" });
      expect(Object.keys(lines[0] as LogEntry).sort()).toEqual(ERROR_LINE_KEYS);
    } finally {
      s.cleanup();
    }
  });

  test("an unrecognized-state refusal reports the state it FOUND, not 'unknown' (G14)", async () => {
    const s = store();
    try {
      dispatched(s.store, "run-1");
      s.store.set("run-1", {
        extensions: { approval: { state: "paused-by-hand", proposal: "p", reportId: "rv-1", headSha: SHA_A } },
      });
      const { lines, threw } = await linesFrom(() => requestApproval(deps(s.store), "run-1", req("rv-9")));
      expect((threw as Error).message).toMatch(/approval-state-unrecognized/);
      expect(lines).toHaveLength(1);
      // The error path's tolerant re-read: the state on disk is what the line
      // carries. "unknown" here would hide the one fact an operator correlating
      // a run that never reached the window is debugging.
      expect(lines[0]).toMatchObject({
        event: "pause",
        outcome: "error",
        status: "error",
        state: "paused-by-hand",
      });
    } finally {
      s.cleanup();
    }
  });

  test("each non-promoting outcome reports the state the RECORD is in", async () => {
    const s = store();
    try {
      // rebound: an awaiting-approval record re-bound to a new report.
      dispatched(s.store, "run-1");
      await requestApproval(deps(s.store), "run-1", req("rv-1"));
      const { lines: rebound } = await linesFrom(() => requestApproval(deps(s.store), "run-1", req("rv-2", SHA_B)));
      expect(rebound[0]).toMatchObject({ outcome: "rebound", state: "awaiting-approval", status: "ok" });

      // already-decided: the terminal state it found, verbatim.
      await submitDecision(deps(s.store), "run-1", {
        decision: "approved",
        approverId: "alice",
        reason: "ok",
        reportId: "rv-2",
      });
      const { lines: decided } = await linesFrom(() => requestApproval(deps(s.store), "run-1", req("rv-3")));
      expect(decided[0]).toMatchObject({ outcome: "already-decided", state: "approved", status: "ok" });

      // pause-in-progress: a `pausing` record owned by a DIFFERENT report.
      dispatched(s.store, "run-2");
      await requestApproval(
        deps(s.store, {
          teardown: async () => {
            throw new Error("crash mid-teardown");
          },
        }),
        "run-2",
        req("rv-a"),
      ).catch(() => {});
      const { lines: inProgress } = await linesFrom(() => requestApproval(deps(s.store), "run-2", req("rv-b")));
      expect(inProgress[0]).toMatchObject({ outcome: "pause-in-progress", state: "pausing", status: "ok" });
    } finally {
      s.cleanup();
    }
  });

  test("the line carries ids, states and durations — never the proposal, the reason or a raw error", async () => {
    const s = store();
    try {
      dispatched(s.store, "run-1");
      // A proposal shaped like the thing that must never be logged. It is a
      // legal proposal — the gate stores it — so the only reason it cannot
      // reach the sink is that the line's field set is closed.
      const secretish = `deploy with sk-or-v1-${"9".repeat(48)}`;
      const { lines } = await linesFrom(() =>
        requestApproval(deps(s.store), "run-1", { proposal: secretish, reportId: "rv-1", headSha: SHA_A }),
      );
      // Before the shape assertion below could pass vacuously on `undefined`,
      // this is what would actually fail — pin the line EXISTS.
      expect(lines).toHaveLength(1);
      const serialized = JSON.stringify(lines[0]);
      expect(serialized).not.toContain("sk-or-v1-");
      expect(serialized).not.toContain("deploy with");
      // The whole field set, pinned. A future field is a deliberate act, not a
      // spread that quietly widened. Same literal as the error line's set
      // above: one closed shape today, shared so a widening is visible in
      // exactly one place.
      expect(Object.keys(lines[0] as LogEntry).sort()).toEqual(ERROR_LINE_KEYS);
    } finally {
      s.cleanup();
    }
  });

  test("a record with no dispatch id logs requestId 'unknown' and OMITS the join key", async () => {
    const s = store();
    try {
      // `store.create` writes {runId, createdAt} only — dispatch is what stamps
      // `requestId`. A record that never went through dispatch has no
      // correlation id, and inventing one would produce a line that looks
      // joinable and joins to nothing.
      s.store.create("run-1");
      const { lines } = await linesFrom(() => requestApproval(deps(s.store), "run-1", req("rv-1")));
      expect(lines[0]?.requestId).toBe("unknown");
      expect(Object.keys(lines[0] as LogEntry)).not.toContain("dispatchRequestId");
    } finally {
      s.cleanup();
    }
  });

  test("a RAISING sink never replaces the gate's outcome — the guard is load-bearing", async () => {
    const s = store();
    try {
      s.store.create("run-1");
      // A sink is process-global and can throw (a closed stream, a bad
      // consumer). Every other emitter in the fleet guards it; `emitPause`'s
      // guard is the same requirement, and an unguarded throw here would
      // surface from `requestApproval` as an approval failure for a pause that
      // actually succeeded — or REPLACE the real error a failed pause meant to
      // raise. Both directions are pinned: the success resolves (its `finally`
      // emit throws into a guard), and the failure re-raises ITS OWN error.
      const restore = setLogSink(() => {
        throw new Error("sink exploded");
      });
      try {
        await expect(requestApproval(deps(s.store), "run-1", req("rv-1"))).resolves.toEqual({
          outcome: "requested",
        });
        expect(s.store.get("run-1").extensions?.approval?.state).toBe("awaiting-approval");

        // The failure direction: the record is re-bound to a NEW run (a
        // rebind against the awaiting one would answer `rebound` and never
        // reach teardown), and the teardown throw — not the sink's — is what
        // the caller meets.
        s.store.create("run-2");
        await expect(
          requestApproval(
            deps(s.store, {
              teardown: async () => {
                throw new Error("box destroy failed");
              },
            }),
            "run-2",
            req("rv-2", SHA_B),
          ),
        ).rejects.toThrow(/box destroy failed/);
      } finally {
        restore();
      }
    } finally {
      s.cleanup();
    }
  });
});

// ─── D6 (round 2): pin the GateDeps.teardown closure lock PATTERN ────────────
// The production wiring is DF3.7's seam (the live half is covered by
// tests/fleet/e2e/tier1-approval-gate.live.test.ts). What a unit test CAN pin
// is the pattern the GateDeps.teardown docstring documents: a closure that
// acquires its OWN lock via acquireRunLock and passes the real handle to
// teardownSandbox works, and wrapping that same closure in withRunLock throws
// RunLockReentrantError — the run lock is NOT re-entrant.

describe("GateDeps.teardown closure pattern (D6): own-lock closure works; withRunLock wrap refuses", () => {
  test("a harness closure acquiring its own lock completes teardown; the withRunLock-wrapped shape throws run-lock-reentrant", async () => {
    const s = store();
    try {
      const driver = new FakeDriver(path.join(s.dir, "boxes"));
      const runId = "df337-tdlock-1";
      await createRun(driver, s.store, { runId }); // box + record, keyless

      // The documented harness shape: the closure holds NO lock when the gate
      // invokes it, so it acquires its own INSIDE and hands the real handle to
      // teardownSandbox — exactly what the type's docstring tells a lock-less
      // caller to do.
      const closure = async (id: string, opts: { noHarvest: true }): Promise<void> => {
        const h = acquireRunLock(s.store.dir, id, "gate-teardown-harness");
        try {
          await teardownSandbox({ driver, store: s.store }, id, h, opts);
        } finally {
          releaseRunLock(h);
        }
      };
      await expect(closure(runId, { noHarvest: true })).resolves.toBeUndefined();
      // The pattern really worked: teardown completed and released — nothing
      // stranded, nothing refused.
      expect(s.store.get(runId).closedAt).toBeString();
      expect(fs.existsSync(path.join(s.store.dir, `${runId}.lock`))).toBe(false);

      // The forbidden shape from the same docstring: wrapping the seam in
      // withRunLock. The outer acquire registers the lock; the closure's own
      // acquireRunLock then refuses RE-ENTRANTLY (held.has, before any claim)
      // — RunLockReentrantError, the programming-error code, not the
      // contention RunLockedError.
      let caught: unknown;
      try {
        await withRunLock(s.store.dir, runId, "wrapped-gate-seam", () => closure(runId, { noHarvest: true }));
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(RunLockReentrantError);
      expect((caught as Error).message).toContain("already holds");
      // And the failed wrap did not strand the OUTER claim either: fn threw
      // non-destructively, so withRunLock released on the way out.
      expect(fs.existsSync(path.join(s.store.dir, `${runId}.lock`))).toBe(false);
    } finally {
      s.cleanup();
    }
  }, 20_000);
});
