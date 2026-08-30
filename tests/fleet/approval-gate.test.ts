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
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { RunRecordStore } from "../../src/providers/run-record.ts";
import { setLogSink, type LogEntry } from "../../src/swarmclaw/log.ts";
import {
  awaitDecision,
  DEFAULT_TIMEOUT_MS,
  expiredState,
  HEAD_SHA_RE,
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
const REPO_SRC = path.join(path.dirname(fs.realpathSync(new URL(import.meta.url).pathname)), "..", "..", "src");

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

/** A teardown that records the approval state it OBSERVED — the order probe. */
function recordingTeardown(s: RunRecordStore, log: string[]): (runId: string) => Promise<void> {
  return async (runId) => {
    log.push(`teardown:${String(s.get(runId).extensions?.approval?.state)}`);
  };
}

const deps = (s: RunRecordStore, extra: Partial<GateDeps> = {}): GateDeps => ({ store: s, ...extra });

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
      expect(log).toEqual(["teardown:pausing"]);
      expect(s.store.get("run-1").extensions?.approval?.state).toBe("awaiting-approval");
    } finally {
      s.cleanup();
    }
  });

  test("teardown runs with noHarvest — the bundle was already harvested", async () => {
    const s = store();
    try {
      s.store.create("run-1");
      const seen: Array<{ noHarvest: boolean }> = [];
      await requestApproval(
        deps(s.store, {
          teardown: async (_id, opts) => {
            seen.push(opts);
          },
        }),
        "run-1",
        req("rv-1"),
      );
      expect(seen).toEqual([{ noHarvest: true }]);
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
      await expect(requestApproval(boom, "run-1", req("rv-1"))).rejects.toThrow(/box destroy failed/);

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
});

describe("AC1 — headSha and reportId are required, not defaulted", () => {
  test.each([
    ["a missing reportId", { proposal: "p", reportId: "", headSha: SHA_A }],
    ["a missing headSha", { proposal: "p", reportId: "rv-1", headSha: "" }],
    ["a short headSha", { proposal: "p", reportId: "rv-1", headSha: "abc" }],
    ["an uppercase headSha", { proposal: "p", reportId: "rv-1", headSha: "A".repeat(40) }],
    ["a 41-char headSha", { proposal: "p", reportId: "rv-1", headSha: "a".repeat(41) }],
  ])("%s is a schema rejection that registers NO namespace", async (_name, bad) => {
    const s = store();
    try {
      s.store.create("run-1");
      await expect(requestApproval(deps(s.store), "run-1", bad)).rejects.toThrow(/reportId|headSha/);
      expect(s.store.get("run-1").extensions?.approval).toBeUndefined();
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
      expect(log).toEqual(["teardown:pausing"]);
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
      s.store.set("run-1", {
        extensions: {
          approval: {
            state: "pausing",
            proposal: "p",
            reportId: "rv-1",
            headSha: SHA_A,
            requestedAt: "2026-08-28T12:00:00.000Z",
            expiresAt: "2026-08-28T12:01:00.000Z",
            supersededReportIds: [],
          },
        },
      });
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
      expect(log).toEqual(["teardown:pausing"]);
      const ext = s.store.get("run-1").extensions?.approval;
      expect(ext?.state).toBe("awaiting-approval");
      // The binding is the one already on disk, not a rebind.
      expect(ext?.reportId).toBe("rv-1");
      expect(ext?.supersededReportIds ?? []).toEqual([]);
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
      s.store.set("run-1", {
        extensions: {
          approval: {
            state: "pausing",
            proposal: "p",
            reportId: "rv-0",
            headSha: SHA_A,
            requestedAt: "2026-08-28T12:00:00.000Z",
            expiresAt: "2026-08-29T12:00:00.000Z",
            supersededReportIds: [],
          },
        },
      });
      const before = fs.readFileSync(s.store.path("run-1"), "utf8");
      const log: string[] = [];
      const out = await requestApproval(deps(s.store, { teardown: recordingTeardown(s.store, log) }), "run-1", req("rv-9"));

      // Resuming here would rebind a record whose box may still be alive.
      expect(out).toEqual({ outcome: "pause-in-progress" });
      expect(log).toEqual([]);
      expect(fs.readFileSync(s.store.path("run-1"), "utf8")).toBe(before);
    } finally {
      s.cleanup();
    }
  });

  test("a pausing record is left BYTE-IDENTICAL and no request is made", async () => {
    const s = store();
    try {
      s.store.create("run-1");
      s.store.set("run-1", {
        extensions: {
          approval: {
            state: "pausing",
            proposal: "p",
            reportId: "rv-0",
            headSha: SHA_A,
            requestedAt: "2026-08-28T12:00:00.000Z",
            expiresAt: "2026-08-29T12:00:00.000Z",
            supersededReportIds: [],
          },
        },
      });
      const before = fs.readFileSync(s.store.path("run-1"), "utf8");
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
        await expect(requestApproval(d, "run-1", req("rv-2", SHA_B))).rejects.toThrow(/bundle/);
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
      s.store.set("run-1", {
        extensions: {
          approval: {
            state: "pausing",
            proposal: "p",
            reportId: "rv-1",
            headSha: SHA_A,
            requestedAt: "2026-08-28T12:00:00.000Z",
            expiresAt: "2026-08-28T12:01:00.000Z",
            supersededReportIds: [],
          },
        },
      });
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
      s.store.set("run-1", {
        extensions: {
          approval: {
            state: "pausing",
            proposal: "p",
            reportId: "rv-1",
            headSha: SHA_A,
            requestedAt: "2026-08-28T12:00:00.000Z",
            expiresAt: "2026-08-29T12:00:00.000Z",
            supersededReportIds: [],
          },
        },
      });
      // The approval lock is deliberately NOT held across teardown, so two
      // same-reportId resumes both reach `deps.teardown` — and its
      // `pullArtifacts` writes fixed shared host paths, which two concurrent
      // pulls race on. The teardown claim serializes them: re-running is
      // idempotent (DF2.5), OVERLAPPING is not.
      let inFlight = 0;
      let maxInFlight = 0;
      let ran = 0;
      const d = deps(s.store, {
        teardown: async () => {
          ran++;
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await Bun.sleep(20);
          inFlight--;
        },
      });
      const outs = await Promise.all([requestApproval(d, "run-1", req("rv-1")), requestApproval(d, "run-1", req("rv-1"))]);

      expect(maxInFlight).toBe(1);
      expect(ran).toBeGreaterThanOrEqual(1);
      expect(s.store.get("run-1").extensions?.approval?.state).toBe("awaiting-approval");
      // The loser of the transition race either resumes behind the winner or
      // rebinds against the already-promoted record — never an error.
      for (const out of outs) expect(["requested", "rebound"]).toContain(out.outcome);
      // …and the claim file is released, not leaked to wedge the next resume.
      expect(fs.readdirSync(s.dir).filter((f) => f.includes(".teardown.claim"))).toEqual([]);
    } finally {
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
      // DF5.2 refuses `approval-incomplete` without BOTH, and
      // `approval-precedes-report` on a stamp older than the report.
      expect(String(ext?.decidedAt)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
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
      s.store.set("run-1", {
        extensions: {
          approval: {
            state: "pausing",
            proposal: "p",
            reportId: "rv-1",
            headSha: SHA_A,
            requestedAt: "2026-08-28T12:00:00.000Z",
            expiresAt: "2026-08-29T12:00:00.000Z",
            supersededReportIds: [],
          },
        },
      });
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

  test("a run with NO approval namespace is not decidable", async () => {
    const s = store();
    try {
      s.store.create("run-1");
      const out = await submitDecision(deps(s.store), "run-1", {
        decision: "approved",
        approverId: "alice",
        reason: "r",
        reportId: "rv-1",
      });
      expect(out).toEqual({ outcome: "not-decidable", state: "absent" });
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
      expect(expiredState({ schemaVersion: 1, state, expiresAt: past }, later)).toBe(state);
    }
  });

  test("a PAUSING record does not expire — it was never awaiting anybody", () => {
    // The box may still be mid-teardown, and a run that never reached
    // `awaiting-approval` had no window for an approver to miss.
    expect(expiredState({ schemaVersion: 1, state: "pausing", expiresAt: past }, later)).toBe("pausing");
  });

  test("an UNPARSEABLE expiresAt does not expire the run", () => {
    // Timing out is a terminal, irreversible abort. A malformed stamp is not
    // evidence that a deadline passed, and treating it as one would abort a
    // live run over a corrupt field.
    for (const expiresAt of ["", "not-a-date", "2026-13-45T99:99:99Z"]) {
      expect(expiredState({ schemaVersion: 1, state: "awaiting-approval", expiresAt }, later)).toBe("awaiting-approval");
    }
    expect(expiredState({ schemaVersion: 1, state: "awaiting-approval" }, later)).toBe("awaiting-approval");
  });

  test("expiry is strictly PAST expiresAt — the boundary instant is still open", () => {
    const ext = { schemaVersion: 1, state: "awaiting-approval", expiresAt: past };
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
      await expect(awaitDecision(deps(s.store), "run-1", { pollMs: 5, waitMs: 50 })).resolves.toMatchObject({
        state: "rejected",
      });
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
      await expect(
        requestApproval(deps(s.store, { teardown: recordingTeardown(s.store, log) }), "run-1", req("rv-1")),
      ).rejects.toThrow(/keyHash/);

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
      await expect(requestApproval(deps(s.store), "run-1", req("rv-1"))).rejects.toThrow(/no teardown seam/);

      // Refused, not promoted — and the evidence-first write still stands, so
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
      expect(log).toEqual(["teardown:pausing"]);
    } finally {
      s.cleanup();
    }
  });
});

describe("withApprovalLock — reclamation is a cross-PROCESS decision", () => {
  // The four in-process arms (dead-pid steal, own-live-pid refusal, the
  // replacement-lock race, the `claimed` fail-closed restore) live in
  // tests/reverify/approval.test.ts:146-345 and are not repeated here. What
  // that file cannot reach is the LIVENESS PREDICATE itself and the age escape
  // above it — both decided from a lock file this process never wrote.

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
  }, 15_000);

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
  }, 30_000);

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
      for (let i = 0; i < 400 && !fs.existsSync(inside); i++) await Bun.sleep(10);
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
      for (let i = 0; i < 400 && !fs.existsSync(inside); i++) await Bun.sleep(10);
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
      for (let i = 0; i < 400 && !fs.existsSync(successorInside); i++) await Bun.sleep(10);
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
      const canary = path.join(s.dir, "canary.approval.lock");
      fs.writeFileSync(canary, "must survive");
      expect(() => reclaimApprovalLock(s.dir, path.join("..", "canary"), true)).toThrow(/invalid run id/);
      expect(fs.readFileSync(canary, "utf8")).toBe("must survive");
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
      const canary = path.join(s.dir, "canary.approval.lock");
      fs.writeFileSync(canary, "must survive");
      let entered = false;
      await expect(
        withApprovalLock(s.dir, path.join("..", "canary"), () => {
          entered = true;
        }),
      ).rejects.toThrow(/invalid run id/);
      expect(entered).toBe(false);
      expect(fs.readFileSync(canary, "utf8")).toBe("must survive");
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
      // And it round-trips: a lone surrogate would come back as U+FFFD.
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
        ).rejects.toThrow(/approverId/);
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

  test("a report re-bound after being displaced is recorded ONCE, not once per cycle", async () => {
    const s = store();
    try {
      s.store.create("run-1");
      const d = deps(s.store);
      await requestApproval(d, "run-1", req("rv-1"));
      await requestApproval(d, "run-1", req("rv-2", SHA_B)); // displaces rv-1
      await requestApproval(d, "run-1", req("rv-1")); // displaces rv-2
      await requestApproval(d, "run-1", req("rv-2", SHA_B)); // displaces rv-1 AGAIN

      const ext = s.store.get("run-1").extensions?.approval;
      expect(ext?.reportId).toBe("rv-2");
      // Every id this run was bound to stays recoverable — which is the only
      // property the DoD asks of this field — without the array growing one
      // element per flap.
      expect(ext?.supersededReportIds).toEqual(["rv-1", "rv-2"]);
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
      await requestApproval(deps(s.store), "run-1", req("rv-9"));
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
      const children = racers.map(([reportId, headSha]) => child(reportId, headSha));
      for (const [reportId] of racers) {
        const ready = path.join(s.dir, `ready-${reportId}`);
        for (let i = 0; i < 1000 && !fs.existsSync(ready); i++) await Bun.sleep(5);
        expect(fs.existsSync(ready)).toBe(true);
      }
      fs.writeFileSync(gate, "");
      const results = await Promise.all(
        children.map(async (c) => ({ code: await c.exited, err: await new Response(c.stderr).text() })),
      );
      const failed = results.filter((r) => r.code !== 0);
      if (failed.length > 0) throw new Error(`children failed:\n${failed.map((r) => r.err).join("\n")}`);

      const ext = s.store.get("run-1").extensions?.approval;
      const known = new Set([String(ext?.reportId), ...((ext?.supersededReportIds as string[]) ?? [])]);
      // Whichever won the lock, all five ids are still recoverable.
      expect([...known].sort()).toEqual(["rv-1", "rv-2", "rv-3", "rv-4", "rv-5"]);
      expect(ext?.supersededReportIds).toHaveLength(4);
    } finally {
      s.cleanup();
    }
  }, 60_000);
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

  // The CLOSED key set of an ERROR pause line — the success line's set (pinned
  // at the bottom of this describe), minus `teardown_at_pause_ms`, which no
  // error path below reaches. Pinned because `toMatchObject` tolerates EXTRA
  // keys: an added `error: err.message` field would pass every shape
  // assertion while quoting operator input (vmName, bundleDir, record fields)
  // onto the shared sink — which is exactly why `emitPause` carries no error
  // text. Sorted, and compared against a sorted key list.
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
      const serialized = JSON.stringify(lines[0]);
      expect(serialized).not.toContain("sk-or-v1-");
      expect(serialized).not.toContain("deploy with");
      // The whole field set, pinned. A future field is a deliberate act, not a
      // spread that quietly widened.
      expect(Object.keys(lines[0] as LogEntry).sort()).toEqual([
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
      ]);
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
});
