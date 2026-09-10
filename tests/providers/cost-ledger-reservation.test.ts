/**
 * F042 — the reservation-row branch matrix, now reachable without a live
 * handle and seeded gate_admissions rows.
 *
 * young/aged x resolves/throws/absent x closed/open, plus the two clock
 * pathologies the guard deliberately treats as young (unparseable and
 * future-dated decided_at) and the unparseable closed_at that retires.
 */
import { describe, expect, test } from "bun:test";

import {
  classifyReservation,
  isReservationYoung,
  type ReservationRecord,
  type ReservationVerdict,
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
