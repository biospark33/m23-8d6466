/**
 * F042 — the reservation-row branch matrix, now reachable without a live
 * handle and seeded gate_admissions rows.
 *
 * young/aged x resolves/throws/absent x closed/open, plus the two clock
 * pathologies the guard deliberately treats as young (unparseable and
 * future-dated decided_at) and the unparseable closed_at that retires.
 *
 * The live-handle block at the bottom covers `releaseAdmission` — the
 * DF2.8-owned compensating release (2026-09-18, operator-sanctioned in DF3.6a's
 * review round) that DF3.6a's two pre-provision refusals call instead of
 * stranding the issue's headroom until the orphan window ages it out.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

import {
  ADMISSION_GRACE_MS,
  ADMISSION_SKEW_MARGIN_MS,
  classifyReservation,
  CostLedger,
  CostLedgerError,
  isReservationYoung,
  type AdmissionInput,
  type ReservationRecord,
  type ReservationVerdict,
  type RunCostRecord,
} from "../../src/providers/cost-ledger.ts";

const CUTOFF = Date.parse("2026-08-01T12:00:00.000Z");
const iso = (offsetMs: number) => new Date(CUTOFF + offsetMs).toISOString();

/** decided_at newer than the cutoff — inside the grace window. */
const YOUNG = { decidedAt: iso(60_000) };
/** decided_at older than the cutoff — past the grace window. */
const AGED = { decidedAt: iso(-60_000) };

const open: ReservationRecord = { kind: "resolved", record: { createdAt: iso(-600_000) } };
const closedYoung: ReservationRecord = {
  kind: "resolved",
  record: { createdAt: iso(-600_000), closedAt: iso(60_000) },
};
const closedAged: ReservationRecord = {
  kind: "resolved",
  record: { createdAt: iso(-600_000), closedAt: iso(-60_000) },
};
const closedAtCutoff: ReservationRecord = {
  kind: "resolved",
  record: { createdAt: iso(-600_000), closedAt: iso(0) },
};
const closedUnparseable: ReservationRecord = {
  kind: "resolved",
  record: { createdAt: iso(-600_000), closedAt: "not-a-date" },
};
const absent: ReservationRecord = { kind: "absent" };
const unreadableOnDisk: ReservationRecord = { kind: "unreadable", structurallyAbsent: false };
const unreadableGone: ReservationRecord = { kind: "unreadable", structurallyAbsent: true };

const reservationMatrix: Array<[{ decidedAt: string }, ReservationRecord, ReservationVerdict]> = [
  // --- resolves, open: the ordinary live reservation. Age is irrelevant. ----
  [YOUNG, open, "count"],
  [AGED, open, "count"],

  // --- resolves, closed: retired only once the close is past the cutoff. ----
  // A young close keeps counting (the close→price race guard).
  [YOUNG, closedYoung, "count"],
  [AGED, closedYoung, "count"],
  [YOUNG, closedAged, "expire"],
  [AGED, closedAged, "expire"],
  // The cutoff itself is EXCLUSIVE on the expire side (closedAtMs < cutoff):
  // a close landing exactly at the cutoff has not proven itself past the
  // close→price window, so it keeps counting (round-3 C14 — same strict `>`
  // symmetry as isReservationYoung; over-reserve, never expire).
  [AGED, closedAtCutoff, "count"],
  // An unparseable closed_at retires — holding it would wedge with no expiry,
  // since the record resolves and the orphan guard never fires.
  [YOUNG, closedUnparseable, "expire"],
  [AGED, closedUnparseable, "expire"],

  // --- absent: the orphan guard. Young still counts (two concurrent ---------
  // dispatches must not each skip the other's reservation); aged is an orphan.
  [YOUNG, absent, "count"],
  [AGED, absent, "expire"],

  // --- throws: young refuses this dispatch rather than undercount. ----------
  [YOUNG, unreadableOnDisk, "refuse"],
  [YOUNG, unreadableGone, "refuse"],
  // Aged: expiry only for a PROVEN structural absence; a record that may still
  // be on disk keeps its ceiling counted (INV-COST-6's direction).
  [AGED, unreadableOnDisk, "hold-unresolvable"],
  [AGED, unreadableGone, "expire-unresolvable"],
];

test.each(reservationMatrix)(
  "classifyReservation(%j, %j) → %s",
  (row, record, expected) => {
    expect(classifyReservation(row, record, CUTOFF)).toBe(expected);
  },
);

describe("isReservationYoung", () => {
  test.each([
    ["inside the window", iso(60_000), true],
    ["at the cutoff", iso(0), false],
    ["past the window", iso(-1), false],
    // Fail-safe: over-reserve, never expire.
    ["unparseable", "not-a-date", true],
    ["empty", "", true],
    ["far future (clock skew)", iso(86_400_000), true],
  ])("%s → %s", (_label, decidedAt, expected) => {
    expect(isReservationYoung({ decidedAt: decidedAt as string }, CUTOFF)).toBe(expected);
  });
});

// ─── releaseAdmission — the compensating release (DF2.8-owned, 2026-09-18) ────
//
// Live-handle sibling of the pure matrix above. gate_admissions is append-only
// (INV-COST-1), so retiring a reservation is a COMPENSATING INSERT into
// gate_admission_releases that every reservation sum excludes — never an
// UPDATE of the admission row. DF3.6a's pre-provision refusals
// (resident-ceiling-unfundable / resident-cap-above-backstop,
// src/fleet/dispatch.ts) call this instead of stranding the issue's entire
// remaining headroom until the orphan window ages it out; aging stays the
// fallback for a dispatch that crashes between the admission and the release.
describe("releaseAdmission", () => {
  let dir: string;
  let ledgerPath: string;
  let ledger: CostLedger;
  /** Pre-provision refusals happen with NO run record; records stay absent. */
  const RECORDS = new Map<string, RunCostRecord>();

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "qds-df28-release-"));
    ledgerPath = join(dir, "cost-ledger.db");
    RECORDS.clear();
    ledger = new CostLedger({
      path: ledgerPath,
      readRunRecord: (runId) => RECORDS.get(runId),
      config: { defaultCapMicroUsd: 5_000_000 },
    });
  });

  afterEach(() => {
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Raw handle for append-only assertions — the module itself never updates. */
  function rawDb(): Database {
    return new Database(ledgerPath);
  }

  const CAP = 5_000_000;
  const A1: AdmissionInput = { repoSlug: "qds/demo", issueId: "42", runId: "run-a1", requestId: "req-1" };

  test("admit → release → a fresh admit sees the headroom back", () => {
    const first = ledger.admitIssue(A1, CAP, CAP);
    if (!first.admitted) throw new Error("expected the first admission to be granted");
    // The F15 pre-flight sees the live reservation, exactly as admission will.
    expect(ledger.issueBudgetSnapshot("qds/demo", "42").reservedMicroUsd).toBe(CAP);

    expect(ledger.releaseAdmission(A1)).toEqual({ released: true });

    // Headroom restored on BOTH readers. Before the release, the retry below
    // refused spend-cap-exceeded (spent 0 + reserved CAP >= cap) — the
    // stranding loop this API exists to close.
    expect(ledger.issueBudgetSnapshot("qds/demo", "42").reservedMicroUsd).toBe(0);
    const retry = ledger.admitIssue(
      { repoSlug: "qds/demo", issueId: "42", runId: "run-a2", requestId: "req-2" },
      CAP,
      CAP,
    );
    if (!retry.admitted) throw new Error(`expected the retry to be granted, got ${retry.reason}`);
    expect(retry.admittedCeilingMicroUsd).toBe(CAP);
    expect(retry.reservedMicroUsd).toBe(0);
  });

  test("the release is a compensating insert — the admission row is untouched, and both tables stay append-only (INV-COST-1)", () => {
    ledger.admitIssue(A1, CAP, CAP);
    const before = rawDb();
    const admissionBefore = before.prepare("SELECT * FROM gate_admissions").all();
    before.close();

    ledger.releaseAdmission(A1);

    const db = rawDb();
    try {
      // No released marker, no mutation: the admission row is byte-identical.
      expect(db.prepare("SELECT * FROM gate_admissions").all()).toEqual(admissionBefore);
      // The release is its own row, in its own append-only table.
      expect((db.prepare("SELECT COUNT(*) AS n FROM gate_admission_releases").get() as { n: number }).n).toBe(1);
      // The triggers bite on BOTH tables — the release mechanics must live
      // entirely within the append-only constraint, never around it.
      expect(() => db.prepare("UPDATE gate_admission_releases SET released_at = 'x'").run()).toThrow();
      expect(() => db.prepare("DELETE FROM gate_admission_releases").run()).toThrow();
      expect(() => db.prepare("UPDATE gate_admissions SET ceiling_micro_usd = 1").run()).toThrow();
    } finally {
      db.close();
    }
  });

  test("releasing an already-released admission is idempotent — no second row", () => {
    ledger.admitIssue(A1, CAP, CAP);
    expect(ledger.releaseAdmission(A1)).toEqual({ released: true });
    expect(ledger.releaseAdmission(A1)).toEqual({ released: false });
    const db = rawDb();
    try {
      expect((db.prepare("SELECT COUNT(*) AS n FROM gate_admission_releases").get() as { n: number }).n).toBe(1);
    } finally {
      db.close();
    }
  });

  test("releasing an admission that does not exist is a typed refusal, not a silent no-op", () => {
    try {
      ledger.releaseAdmission({ repoSlug: "qds/demo", issueId: "42", runId: "run-nope", requestId: "req-nope" });
      throw new Error("expected admission-release-unknown");
    } catch (e) {
      expect(e).toBeInstanceOf(CostLedgerError);
      expect((e as CostLedgerError).code).toBe("admission-release-unknown");
    }
  });

  test("releasing under ANOTHER issue's identity is refused — the replay branch's fail-closed rule", () => {
    ledger.admitIssue(A1, CAP, CAP);
    try {
      ledger.releaseAdmission({ ...A1, issueId: "43" });
      throw new Error("expected admission-release-mismatch");
    } catch (e) {
      expect(e).toBeInstanceOf(CostLedgerError);
      expect((e as CostLedgerError).code).toBe("admission-release-mismatch");
    }
  });

  test("replaying a RELEASED admission's correlation id mints nothing", () => {
    ledger.admitIssue(A1, CAP, CAP);
    ledger.releaseAdmission(A1);
    // The replay branch must not hand the recorded ceiling back: a released
    // admission holds no reservation, so that would mint an unreserved
    // ceiling — the exact hole the DO NOTHING branch exists to close.
    try {
      ledger.admitIssue(A1, CAP, CAP);
      throw new Error("expected ledger-admission-released");
    } catch (e) {
      expect(e).toBeInstanceOf(CostLedgerError);
      expect((e as CostLedgerError).code).toBe("ledger-admission-released");
    }
  });

  test("aging still retires an UNRELEASED orphan — the fallback is unchanged", () => {
    // Back-dated raw insert past the window (the admitAged idiom from
    // cost-ledger.test.ts — gate_admissions is append-only, so age can only be
    // written, never rewritten), with NO record and NO release.
    const db = rawDb();
    try {
      db.prepare(
        `INSERT INTO gate_admissions (request_id, run_id, repo_slug, issue_id, ceiling_micro_usd, decided_at)
         VALUES (?,?,?,?,?,?)`,
      ).run(
        "req-aged",
        "run-aged",
        "qds/demo",
        "42",
        CAP,
        new Date(Date.now() - ADMISSION_GRACE_MS - ADMISSION_SKEW_MARGIN_MS - 40_000).toISOString(),
      );
    } finally {
      db.close();
    }
    const next = ledger.admitIssue(
      { repoSlug: "qds/demo", issueId: "42", runId: "run-next", requestId: "req-next" },
      CAP,
      CAP,
    );
    if (!next.admitted) throw new Error(`expected the aged orphan to expire, got ${next.reason}`);
    expect(next.admittedCeilingMicroUsd).toBe(CAP);
  });
});
