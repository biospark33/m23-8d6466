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
import {
  awaitDecision,
  DEFAULT_TIMEOUT_MS,
  expiredState,
  HEAD_SHA_RE,
  MAX_PROPOSAL_CHARS,
  MAX_REASON_CHARS,
  MAX_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
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
      // The record a crash between (a) and (c) leaves behind. Before AC1(c) was
      // implemented nothing anywhere promoted out of `pausing` — `expiredState`
      // never expires it and `submitDecision` calls it not-decidable — so this
      // run was stranded until somebody hand-edited the JSON.
      s.store.set("run-1", {
        extensions: { approval: { state: "pausing", proposal: "p", reportId: "rv-1", headSha: SHA_A } },
      });
      const log: string[] = [];
      const out = await requestApproval(deps(s.store, { teardown: recordingTeardown(s.store, log) }), "run-1", req("rv-1"));

      expect(out).toEqual({ outcome: "requested" });
      // Teardown RE-RAN (idempotent under DF2.5) and still observed `pausing` —
      // the resume never promotes ahead of the box being destroyed.
      expect(log).toEqual(["teardown:pausing"]);
      const ext = s.store.get("run-1").extensions?.approval;
      expect(ext?.state).toBe("awaiting-approval");
      // The binding is the one already on disk, not a rebind: a resume writes
      // nothing but the promotion.
      expect(ext?.reportId).toBe("rv-1");
      expect(ext?.supersededReportIds ?? []).toEqual([]);
    } finally {
      s.cleanup();
    }
  });

  test("a pausing record bound to a DIFFERENT report is a collision, not a resume", async () => {
    const s = store();
    try {
      s.store.create("run-1");
      s.store.set("run-1", {
        extensions: { approval: { state: "pausing", proposal: "p", reportId: "rv-0", headSha: SHA_A } },
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
        extensions: { approval: { state: "pausing", proposal: "p", reportId: "rv-0", headSha: SHA_A } },
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
        await expect(requestApproval(d, "run-1", req("rv-2", SHA_B))).rejects.toThrow(/bundle/);
        // Refused ⇒ the binding is untouched.
        expect(s.store.get("run-1").extensions?.approval?.reportId).toBe("rv-1");
      } finally {
        fs.rmSync(bundles, { recursive: true, force: true });
      }
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
      const out = await submitDecision(d, "run-1", { decision: "approved", approverId: "alice", reason: "stale", reportId: "rv-1" });

      expect(out).toEqual({ outcome: "report-changed", reportId: "rv-2" });
      expect(s.store.get("run-1").extensions?.approval?.state).toBe("awaiting-approval");
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
        extensions: { approval: { state: "pausing", proposal: "p", reportId: "rv-1", headSha: SHA_A } },
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

  test("a lock held by a LIVE FOREIGN process (EPERM) is never reclaimed", async () => {
    const s = store();
    try {
      s.store.create("run-1");
      const lock = path.join(s.dir, "run-1.approval.lock");
      // pid 1 is init/launchd: root-owned, so `process.kill(1, 0)` raises
      // EPERM rather than ESRCH for any non-root caller. That is the whole
      // point — EPERM means "alive but not ours", and `isLockHolderDead`
      // returning `true` on ANY kill error (rather than on ESRCH alone) would
      // let this process steal a live holder's lock. The own-pid test next
      // door cannot catch that: `kill(self, 0)` never throws, so the broken
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

  test("a lock past the ABANDON age is reclaimed even though its pid still resolves", async () => {
    const s = store();
    try {
      s.store.create("run-1");
      const lock = path.join(s.dir, "run-1.approval.lock");
      // Own pid: verifiably alive, so the liveness predicate can NEVER prove
      // death — which is exactly what a recycled pid looks like once the OS
      // wraps onto a dead holder's number. Without an age escape every verb
      // for this run fails at LOCK_TIMEOUT_MS forever, with no remedy but
      // deleting the file by hand.
      fs.writeFileSync(lock, `${process.pid}:recycled-pid`);
      const ancient = new Date(Date.now() - 2 * 60 * 60 * 1000); // 2h, past LOCK_ABANDON_MS
      fs.utimesSync(lock, ancient, ancient);

      expect(await withApprovalLock(s.dir, "run-1", () => "entered")).toBe("entered");
      expect(fs.existsSync(lock)).toBe(false);
    } finally {
      s.cleanup();
    }
  });

  test("an hour-scale abandon age keeps the minute-scale live-holder refusal intact", async () => {
    const s = store();
    try {
      s.store.create("run-1");
      const lock = path.join(s.dir, "run-1.approval.lock");
      // The paired half of the test above. An abandon age at or below the
      // 60 s the reclamation suite backdates by would turn every one of those
      // "a live holder is NOT reclaimed" tests into an age-based steal — the
      // guarded body is one read-decide-write, so an hour is four orders of
      // magnitude past any honest holder and a minute is not.
      fs.writeFileSync(lock, `${process.pid}:still-working`);
      const old = new Date(Date.now() - 10 * 60_000); // 10 min: stale, not abandoned
      fs.utimesSync(lock, old, old);

      await expect(withApprovalLock(s.dir, "run-1", () => "entered")).rejects.toThrow(/held for over/);
      expect(fs.existsSync(lock)).toBe(true);
    } finally {
      s.cleanup();
    }
  }, 15_000);

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

  test("two rebinds from separate PROCESSES lose neither displaced id", async () => {
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
      const gate = path.join(s.dir, "go");
      const child = (reportId: string, headSha: string) =>
        Bun.spawn(
          [
            "bun",
            "-e",
            `const { requestApproval } = await import(${JSON.stringify(path.join(REPO_SRC, "fleet", "approval-gate.ts"))});
             const { RunRecordStore } = await import(${JSON.stringify(path.join(REPO_SRC, "providers", "run-record.ts"))});
             const fs = await import("node:fs");
             while (!fs.existsSync(${JSON.stringify(gate)})) await Bun.sleep(2);
             const store = new RunRecordStore({ dir: ${JSON.stringify(s.dir)} });
             await requestApproval({ store }, "run-1", { proposal: "p", reportId: ${JSON.stringify(reportId)}, headSha: ${JSON.stringify(headSha)} });`,
          ],
          { stdout: "pipe", stderr: "pipe" },
        );
      const a = child("rv-2", SHA_B);
      const b = child("rv-3", SHA_A);
      await Bun.sleep(400); // both children are parked on the gate file
      fs.writeFileSync(gate, "");
      const [ea, eb, errA, errB] = await Promise.all([
        a.exited,
        b.exited,
        new Response(a.stderr).text(),
        new Response(b.stderr).text(),
      ]);
      if (ea !== 0 || eb !== 0) throw new Error(`child exits ${ea}/${eb}\n${errA}\n${errB}`);

      const ext = s.store.get("run-1").extensions?.approval;
      const known = new Set([String(ext?.reportId), ...((ext?.supersededReportIds as string[]) ?? [])]);
      // Whichever won the lock, all three ids are still recoverable.
      expect([...known].sort()).toEqual(["rv-1", "rv-2", "rv-3"]);
      expect(ext?.supersededReportIds).toHaveLength(2);
    } finally {
      s.cleanup();
    }
  }, 30_000);
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

  test("a PERSISTED timeout and a DERIVED one report the same reason", async () => {
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
      // disagree about why a run stopped.
      expect(derived?.reason).toBe(String(persisted?.reason));
      expect(derived?.approverId).toBe(String(persisted?.approverId));
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
