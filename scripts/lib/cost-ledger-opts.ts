/**
 * Where a run's money lives, resolved from where its RECORDS live — shared by
 * every CLI that can move either half of a run's money (`scripts/fleet.ts`
 * reserves budget at dispatch, `scripts/sandbox-teardown.ts` settles box hours
 * at teardown).
 *
 * The ledger and the cost config are SIBLINGS of the records directory, so a
 * run whose records moved must take its money with it: otherwise the dispatch
 * reserves budget against one ledger file and the teardown settles box hours
 * against another — the reservation then stays open forever, counting against
 * the budget cap, while the spend lands somewhere nobody reads. Both CLIs call
 * through here, in one implementation, for the same reason the run lock does
 * (scripts/lib/run-lock.ts): "identical semantics maintained by two parallel
 * implementations" is a promise nothing enforces, and this one had already
 * broken — sandbox-teardown built its `CostLedger` with no `path` at all and
 * settled into the cwd-relative default.
 *
 * Keyed on `store.dir` — the directory actually in use — NOT on whether `--dir`
 * was typed. `QDS_RUNS_DIR=/srv/runs` and an embedder injecting `deps.store`
 * move the records exactly as `--dir` does, and branching on the flag left both
 * of those falling back to the cwd-relative default while the records sat
 * elsewhere.
 *
 * On the RESOLVED store dir. A relative `--dir runs` made the ledger
 * cwd-relative, so two invocations from two cwds used two ledgers — the exact
 * cwd-split this module exists to eliminate, reintroduced one level up.
 *
 * The two halves resolve DIFFERENTLY, because they are different kinds of file:
 *
 *  - the LEDGER is written, and it is the thing that must not be shared. A
 *    sibling ledger belongs to every store under the same parent, so
 *    `--dir /srv/runs-prod` and `--dir /srv/runs-staging` settled into one
 *    `/srv/cost-ledger.db` and per-issue caps admitted across unrelated fleets.
 *    It also put money in the records dir's PARENT, frequently root-owned
 *    (`SQLITE_CANTOPEN`). So it goes INSIDE the records directory, which is
 *    already the per-fleet, mode-0700 boundary. (`listWithAnomalies` reads only
 *    `*.json`, so the db and its `-wal`/`-shm` are invisible to record listings.)
 *  - the CONFIG is read, and it is the OPERATOR's — caps and the box-hour rate,
 *    written by hand beside the records directory in every deployment there is.
 *    It stays a sibling: relocating it under `--dir` would find nothing and
 *    silently substitute the built-in defaults for their caps.
 *
 * The DEFAULT layout is unchanged either way, special-cased rather than
 * migrated: `.sandbox/runs` keeps settling into `.sandbox/cost-ledger.db`,
 * because a lot of existing state is already there and CostLedger's own default
 * tier points at the same file.
 *
 * $QDS_COST_LEDGER_FILE / $QDS_COST_CONFIG_FILE still win, restated here rather
 * than left to CostLedger's own tier because the DEFAULT below is no longer the
 * one CostLedger would pick. An explicit env override is one file for both
 * halves, so it cannot split a run's money either.
 */
import { basename, dirname, join, resolve } from "node:path";

import {
  DEFAULT_COST_CONFIG_FILE,
  DEFAULT_COST_LEDGER_FILE,
  loadCostConfig,
} from "../../src/providers/cost-ledger.ts";
import { DEFAULT_RUNS_DIR } from "../../src/providers/run-record.ts";

/**
 * An UNSET override is undefined; an EMPTY one (`export QDS_COST_LEDGER_FILE=
 * "$UNSET"`) is a path that resolves to the cwd, and `??` passed it straight
 * through — for the config that ENOENTs into DEFAULT_COST_CONFIG, so the caps
 * silently revert to defaults while the operator believes the override took.
 */
function envPath(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === "" ? undefined : value;
}

export function costLedgerOpts(storeDir: string) {
  const dir = resolve(storeDir);
  // The default layout is the one place the ledger stays a sibling.
  const ledgerDir = dir === resolve(DEFAULT_RUNS_DIR) ? dirname(dir) : dir;
  return {
    path: envPath(process.env.QDS_COST_LEDGER_FILE) ?? join(ledgerDir, basename(DEFAULT_COST_LEDGER_FILE)),
    // An absent cost-config.json falls back to DEFAULT_COST_CONFIG
    // (loadCostConfig maps ENOENT to defaults); an unreadable one still throws.
    config: loadCostConfig(
      envPath(process.env.QDS_COST_CONFIG_FILE) ?? join(dirname(dir), basename(DEFAULT_COST_CONFIG_FILE)),
    ).config,
  };
}
