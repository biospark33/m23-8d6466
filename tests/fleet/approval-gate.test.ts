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
  expiredState,
  HEAD_SHA_RE,
  MIN_TIMEOUT_MS,
  requestApproval,
  submitDecision,
  sweepExpired,
  TIMEOUT_APPROVER_ID,
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
      await submitDecision(d, "run-1", { decision: "approved", approverId: "alice", reason: "ok", reportId: "rv-3" });

      const ext = s.store.get("run-1").extensions?.approval;
      const known = [String(ext?.reportId), ...((ext?.supersededReportIds as string[]) ?? [])];
      expect(known).toEqual(["rv-3", "rv-1", "rv-2"]);
      // The decision landed against the pair the approver saw, and every id
      // this run was ever bound to is still recoverable from the record.
      expect(known).toContain("rv-3");
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
