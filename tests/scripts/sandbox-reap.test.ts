/**
 * scripts/sandbox-reap CLI — the hygiene half (F044).
 *
 * The classification/apply behaviour is covered by tests/providers/reaper.test.ts
 * (including the mandatory script e2e demo). What lives here is the CLI's own
 * side effects: a dry run's contract is "classify the fleet, write the report,
 * delete nothing" — and *create* nothing either. The CostLedger was built
 * unconditionally in the sweep(...) argument list, and its constructor mkdirs,
 * chmods and opens the db + WAL, so the read-only mode left three new files
 * behind on every invocation and never closed the handle.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { run as runReap } from "../../scripts/sandbox-reap.ts";
import type { SweepDeps } from "../../src/providers/reaper.ts";
import type { LoadedQuotaLimits } from "../../src/providers/quota.ts";
import { seedFleet } from "../providers/fixtures/fleet-state.ts";

const NOW = new Date("2026-08-20T12:00:00.000Z");
const HOUR = 3_600_000;
const LIMITS: LoadedQuotaLimits = {
  limits: { maxVms: 50, maxPooledDiskGiB: 100, perVmDiskReservationGiB: 2, maxTransferGiB: 200, staleAfterMs: 14_400_000 },
  source: "default",
};

let dir: string;
let prevCwd: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qds-reap-cli-"));
  prevCwd = process.cwd();
  process.chdir(dir);
});

afterEach(() => {
  process.chdir(prevCwd);
  rmSync(dir, { recursive: true, force: true });
});

test("F044: a dry run creates no cost-ledger.db (nor its WAL sidecars)", async () => {
  const fleet = await seedFleet(join(dir, "fleet"), {
    vms: [{ name: "df26v-20260820-cccc03" }],
    keys: [{ runId: "df26k-20260820-dddd04", createdAt: new Date(NOW.getTime() - 5 * HOUR).toISOString() }],
    records: [],
  }, NOW);
  const reapDir = join(dir, "reap");
  const deps: Partial<SweepDeps> = {
    driver: fleet.driver,
    store: fleet.store,
    keyApi: fleet.keyApi,
    limits: LIMITS,
    reapDir,
    now: () => NOW,
  };

  const lines: string[] = [];
  const exit = await runReap([], (s) => lines.push(s), deps);

  expect(exit).toBe(0);
  expect(lines.join("")).toContain("dry-run:");
  // The report IS written in both modes — that is the dry run's whole output.
  expect(readdirSync(reapDir)).toHaveLength(1);
  // Nothing else is. The ledger resolves INSIDE the records dir for a
  // non-default layout (costLedgerOpts), so that is where a leaked db lands.
  const ledger = join(fleet.store.dir, "cost-ledger.db");
  for (const p of [ledger, `${ledger}-wal`, `${ledger}-shm`]) {
    expect(existsSync(p)).toBeFalse();
  }
});
