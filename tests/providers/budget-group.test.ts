/**
 * Budget-group reservation tests (Q1.2) — TDD RED phase.
 *
 * The group cap (G6): a DAG run's submits share one ceiling, enforced in ONE
 * ledger transaction — the SUM read and the INSERT are atomic, so two
 * concurrent submits cannot both read the same headroom and both spend it
 * (the same BEGIN IMMEDIATE discipline admitIssue's cap decision uses).
 *
 * Coverage:
 * - reservation appends; the outstanding sum counts it
 * - a reservation past the cap refuses, and refuses ATOMICALLY (no row)
 * - CONCURRENCY: parallel reserves against one group cannot double-spend —
 *   exactly floor(cap/amount) admit, the rest refuse, and the admitted sum
 *   never exceeds the cap
 * - replay: the same (groupId, requestId) reserve is idempotent — the second
 *   call answers from the first's row instead of reserving twice
 * - release retires the row from the sum; a re-reserve then fits; a second
 *   release is a no-op
 * - input hygiene: missing identity fields refuse BEFORE any write
 * - append-only: no UPDATE/DELETE on the admissions table (INV-COST-1's rule,
 *   carried to the group tables)
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CostLedger, CostLedgerError, type RunCostRecord } from "../../src/providers/cost-ledger.ts";

const tmpRoot = mkdtempSync(join(tmpdir(), "q1-budget-group-"));
afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

let dir: string;
let ledgerPath: string;
let ledger: CostLedger;

const RECORDS = new Map<string, RunCostRecord>();

const IDENTITY = {
  groupId: "dag-2026-09",
  repoSlug: "owner/repo",
  issueKey: "dag/build-docs",
};

function req(n: number): string {
  // Distinct strict-v4 UUIDs per index (deterministic — never minted).
  const hex = n.toString(16).padStart(12, "0");
  return `5e5a3c8e-1f2b-4c3d-9a8e-${hex}`;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpRoot, "g-"));
  ledgerPath = join(dir, "cost-ledger.db");
  RECORDS.clear();
  ledger = new CostLedger({
    path: ledgerPath,
    readRunRecord: (runId) => RECORDS.get(runId),
    config: { defaultCapMicroUsd: 5_000_000, boxHourRateMicroUsd: 3_600_000 },
  });
});

afterEach(() => {
  ledger.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Raw handle for trigger/schema assertions — the module itself never updates. */
function rawDb(): Database {
  return new Database(ledgerPath);
}

describe("reserveBudgetGroup (Q1.2)", () => {
  test("reservation appends one row and counts toward the group's outstanding sum", () => {
    const a = ledger.reserveBudgetGroup({ ...IDENTITY, requestId: req(1), amountMicroUsd: 300_000 }, 1_000_000);
    expect(a.admitted).toBe(true);
    const b = ledger.reserveBudgetGroup({ ...IDENTITY, requestId: req(2), amountMicroUsd: 300_000 }, 1_000_000);
    expect(b.admitted).toBe(true);
    expect(b.reservedMicroUsd).toBe(600_000);
    const db = rawDb();
    const rows = db
      .query<{ n: number; total: number }, []>(
        "SELECT COUNT(*) AS n, COALESCE(SUM(reserved_micro_usd), 0) AS total FROM budget_group_admissions",
      )
      .get()!;
    expect(rows.n).toBe(2);
    expect(rows.total).toBe(600_000);
    db.close();
  });

  test("a reservation past the cap refuses ATOMICALLY — no row, the sum unchanged", () => {
    ledger.reserveBudgetGroup({ ...IDENTITY, requestId: req(1), amountMicroUsd: 700_000 }, 1_000_000);
    let err: unknown;
    try {
      ledger.reserveBudgetGroup({ ...IDENTITY, requestId: req(2), amountMicroUsd: 700_000 }, 1_000_000);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CostLedgerError);
    expect((err as CostLedgerError).code).toBe("budget-group-exceeded");
    const db = rawDb();
    const row = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM budget_group_admissions").get()!;
    expect(row.n).toBe(1);
    db.close();
  });

  test("CONCURRENCY: parallel reserves cannot double-spend — exactly the fitting count admits", async () => {
    // 8 x 300_000 against 1_000_000: exactly 3 can fit. The handles share the
    // ledger FILE (what two CLI processes share), so the serialization under
    // test is SQLite's, not one process's in-memory state.
    const CAP = 1_000_000;
    const handles = Array.from({ length: 8 }, () => new CostLedger({
      path: ledgerPath,
      readRunRecord: (runId) => RECORDS.get(runId),
      config: { defaultCapMicroUsd: 5_000_000, boxHourRateMicroUsd: 3_600_000 },
    }));
    const results = await Promise.all(
      handles.map((h, i) =>
        Promise.resolve()
          .then(() => h.reserveBudgetGroup({ ...IDENTITY, requestId: req(i + 1), amountMicroUsd: 300_000 }, CAP))
          .then(
            () => "admitted" as const,
            (e: unknown) => ((e as CostLedgerError).code === "budget-group-exceeded" ? "refused" : "error"),
          )
          .finally(() => h.close()),
      ),
    );
    expect(results.filter((r) => r === "admitted")).toHaveLength(3);
    expect(results.filter((r) => r === "refused")).toHaveLength(5);
    const db = rawDb();
    const row = db
      .query<{ total: number }, []>("SELECT COALESCE(SUM(reserved_micro_usd), 0) AS total FROM budget_group_admissions")
      .get()!;
    expect(row.total).toBe(900_000);
    db.close();
  });

  test("replay: the same (groupId, requestId) reserves ONCE and answers from that row", () => {
    const first = ledger.reserveBudgetGroup({ ...IDENTITY, requestId: req(1), amountMicroUsd: 300_000 }, 1_000_000);
    const second = ledger.reserveBudgetGroup({ ...IDENTITY, requestId: req(1), amountMicroUsd: 300_000 }, 1_000_000);
    expect(second.admitted).toBe(true);
    expect(second.reservedMicroUsd).toBe(first.reservedMicroUsd);
    expect(second.replayed).toBe(true);
    const db = rawDb();
    const row = db
      .query<{ n: number; total: number }, []>(
        "SELECT COUNT(*) AS n, COALESCE(SUM(reserved_micro_usd), 0) AS total FROM budget_group_admissions",
      )
      .get()!;
    expect(row.n).toBe(1);
    expect(row.total).toBe(300_000);
    db.close();
  });

  test("release retires the reservation; a re-reserve then fits; a second release is a no-op", () => {
    ledger.reserveBudgetGroup({ ...IDENTITY, requestId: req(1), amountMicroUsd: 700_000 }, 1_000_000);
    const rel = ledger.releaseBudgetGroup({ groupId: IDENTITY.groupId, requestId: req(1) });
    expect(rel.released).toBe(true);
    // Headroom is back.
    const again = ledger.reserveBudgetGroup({ ...IDENTITY, requestId: req(2), amountMicroUsd: 700_000 }, 1_000_000);
    expect(again.admitted).toBe(true);
    // Idempotent: releasing twice succeeds once, no-op the second time.
    const rel2 = ledger.releaseBudgetGroup({ groupId: IDENTITY.groupId, requestId: req(1) });
    expect(rel2.released).toBe(false);
    const db = rawDb();
    const releases = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM budget_group_releases").get()!;
    expect(releases.n).toBe(1);
    db.close();
  });

  test("input hygiene: a missing identity or non-positive amount refuses BEFORE any write", () => {
    for (const bad of [
      { ...IDENTITY, requestId: "", amountMicroUsd: 100 },
      { ...IDENTITY, groupId: "", requestId: req(1), amountMicroUsd: 100 },
      { ...IDENTITY, repoSlug: "", requestId: req(1), amountMicroUsd: 100 },
      { ...IDENTITY, issueKey: "", requestId: req(1), amountMicroUsd: 100 },
      { ...IDENTITY, requestId: req(1), amountMicroUsd: 0 },
      { ...IDENTITY, requestId: req(1), amountMicroUsd: -5 },
    ] as const) {
      let err: unknown;
      try {
        ledger.reserveBudgetGroup(bad, 1_000_000);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(CostLedgerError);
      expect((err as CostLedgerError).code).toBe("budget-group-input-invalid");
    }
    const db = rawDb();
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM budget_group_admissions").get()!.n).toBe(0);
    db.close();
  });

  test("append-only carries to the group tables: UPDATE and DELETE abort (INV-COST-1)", () => {
    ledger.reserveBudgetGroup({ ...IDENTITY, requestId: req(1), amountMicroUsd: 300_000 }, 1_000_000);
    const db = rawDb();
    expect(() => db.exec("UPDATE budget_group_admissions SET reserved_micro_usd = 1")).toThrow(
      /budget_group_admissions is append-only/,
    );
    expect(() => db.exec("DELETE FROM budget_group_admissions")).toThrow(/budget_group_admissions is append-only/);
    db.close();
  });

  test("the cap check runs against BOTH the group's outstanding sum AND refuses a non-positive cap", () => {
    let err: unknown;
    try {
      ledger.reserveBudgetGroup({ ...IDENTITY, requestId: req(1), amountMicroUsd: 100 }, 0);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CostLedgerError);
    expect((err as CostLedgerError).code).toBe("budget-group-input-invalid");
  });
});

describe("releaseBudgetGroupByRequest (A2 follow-up, swarmclaw#808 seam 2)", () => {
  test("sequential submits release through teardown: a settled-but-unreleased first leg no longer wedges leg N+1", () => {
    // The live round's wedge, replayed: leg 1 reserves 700k of a 1M group cap;
    // leg 2's submit MUST refuse while leg 1's reservation is outstanding —
    // this is the pre-fix wedge, exactly what release-all.ts swept.
    ledger.reserveBudgetGroup({ ...IDENTITY, requestId: req(1), amountMicroUsd: 700_000 }, 1_000_000);
    let wedge: unknown;
    try {
      ledger.reserveBudgetGroup({ ...IDENTITY, requestId: req(2), amountMicroUsd: 700_000 }, 1_000_000);
    } catch (e) {
      wedge = e;
    }
    expect(wedge).toBeInstanceOf(CostLedgerError);
    expect((wedge as CostLedgerError).code).toBe("budget-group-exceeded");

    // Leg 1 settles: the close path releases by the requestId it owns (the
    // admission row is the identity map — no group id reaches teardown).
    const released = ledger.releaseBudgetGroupByRequest(req(1));
    expect(released).toEqual({ released: true });

    // Leg N+1 now fits under the same cap — no operator sweep required.
    const second = ledger.reserveBudgetGroup({ ...IDENTITY, requestId: req(2), amountMicroUsd: 700_000 }, 1_000_000);
    expect(second.admitted).toBe(true);

    // Idempotent: releasing the settled leg again is the documented no-op.
    expect(ledger.releaseBudgetGroupByRequest(req(1))).toEqual({ released: false });
    // A requestId with no admission (every non-budget-group run) is a no-op
    // too, so the close path can fire it unconditionally.
    expect(ledger.releaseBudgetGroupByRequest(req(99))).toEqual({ released: false });
    // The ledger stays append-only: exactly two admissions + one release row.
    const db = rawDb();
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM budget_group_admissions").get()!.n).toBe(2);
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM budget_group_releases").get()!.n).toBe(1);
    db.close();
  });

  test("release-by-request refuses a NULL-bind requestId pre-write", () => {
    let err: unknown;
    try {
      ledger.releaseBudgetGroupByRequest("");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CostLedgerError);
    expect((err as CostLedgerError).code).toBe("budget-group-input-invalid");
  });
});
