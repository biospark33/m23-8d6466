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
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { run as runReap } from "../../scripts/sandbox-reap.ts";
import { hostTag } from "../../scripts/lib/run-lock.ts";
import type { SweepDeps } from "../../src/providers/reaper.ts";
import type { LoadedQuotaLimits } from "../../src/providers/quota.ts";
import { seedFleet } from "../providers/fixtures/fleet-state.ts";
import { useTempAuditStore } from "../fleet/helpers.ts";

// PRE-EXISTING LEAK (found reviewing PR #258). `--yes` makes this CLI a
// composition root: it calls `openAuditStore()` with no argument, which resolves
// `QDS_AUDIT_DB ?? ".sandbox/audit.db"` RELATIVE TO CWD — and this suite runs
// with cwd = repo root. The apply-mode case below therefore opened (and, on a
// clean checkout, CREATED) the operator's live audit store, co-resident with the
// evidence of real runs. The helper's own docstring already declares itself
// mandatory for exactly this shape; this suite predates it.
useTempAuditStore();

const NOW = new Date("2026-08-20T12:00:00.000Z");
const HOUR = 3_600_000;
const LIMITS: LoadedQuotaLimits = {
  limits: { maxVms: 50, maxPooledDiskGiB: 100, perVmDiskReservationGiB: 2, maxTransferGiB: 200, staleAfterMs: 14_400_000 },
  source: "default",
};

let dir: string;

// No process.chdir: every path this test cares about arrives through the
// injected deps (store, reapDir), so the cwd is not load-bearing here — and a
// chdir that escapes its restore corrupts every later test in the process.
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qds-reap-cli-"));
});

afterEach(() => {
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

// ─── D1 (round 2): the refusal summary line distinguishes run-locked noise ──

test("D1: an apply sweep with a run-locked refusal prints the distinct summary line and still exits 1", async () => {
  const R_EXEC = "locke-20260820-000007";
  const R_LOCK = "lockf-20260820-000008";
  const fleet = await seedFleet(join(dir, "fleet"), {
    vms: [{ name: R_EXEC }, { name: R_LOCK }],
    keys: [
      { runId: R_EXEC, createdAt: new Date(NOW.getTime() - 5 * HOUR).toISOString() },
      { runId: R_LOCK, createdAt: new Date(NOW.getTime() - 5 * HOUR).toISOString() },
    ],
    records: [{ runId: R_EXEC, ageMs: 5 * HOUR }, { runId: R_LOCK, ageMs: 5 * HOUR }],
  }, NOW);
  // The refusal's holder, planted the way the stale-arm test in reaper.test.ts
  // plants it: a body whose pid has ALREADY exited — the same proof isAlive
  // uses — so the refusal is deterministic and no child process is needed.
  const dead = Bun.spawnSync(["true"]);
  writeFileSync(
    join(fleet.store.dir, `${R_LOCK}.lock`),
    `${dead.pid} ${hostTag()} ${new Date(NOW.getTime() - 60_000).toISOString()} deadbeef\n`,
    { mode: 0o600 },
  );
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
  const exit = await runReap(["--yes"], (s) => lines.push(s), deps);

  // The exit-code contract is UNCHANGED: refusals land in `failures`, and a
  // non-empty `failures` on an apply still exits 1.
  expect(exit).toBe(1);
  const summary = lines.find((l) => l.includes("refused run-locked"));
  // One line, distinct from the per-unit `!! run-locked:` frames, naming BOTH
  // numbers a cron/CI consumer needs: how many units refused, how many ran.
  expect(summary).toBeDefined();
  expect(summary).toBe("1 unit(s) refused run-locked — refusals are not failures; the sweep executed 1 unit(s)\n");
  // The per-unit refusal frames are still there — the summary ADDS the
  // distinction, it does not replace the detail.
  expect(lines.join("")).toContain("!! run-locked:");
  // The executed unit really executed; the refused one did not.
  expect(fleet.store.get(R_EXEC).closedAt).toBeString();
  expect(fleet.store.get(R_LOCK).closedAt).toBeUndefined();
});
