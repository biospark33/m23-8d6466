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
 * $QDS_COST_LEDGER_FILE / $QDS_COST_CONFIG_FILE still win, restated here rather
 * than left to CostLedger's own tier because the DEFAULT below is no longer the
 * one CostLedger would pick. An explicit env override is one file for both
 * halves, so it cannot split a run's money either.
 */
import { basename, dirname, join } from "node:path";

import {
  DEFAULT_COST_CONFIG_FILE,
  DEFAULT_COST_LEDGER_FILE,
  loadCostConfig,
} from "../../src/providers/cost-ledger.ts";

export function costLedgerOpts(storeDir: string) {
  const sandboxDir = dirname(storeDir);
  return {
    path: process.env.QDS_COST_LEDGER_FILE ?? join(sandboxDir, basename(DEFAULT_COST_LEDGER_FILE)),
    // An absent cost-config.json falls back to DEFAULT_COST_CONFIG
    // (loadCostConfig maps ENOENT to defaults); an unreadable one still throws.
    config: loadCostConfig(process.env.QDS_COST_CONFIG_FILE ?? join(sandboxDir, basename(DEFAULT_COST_CONFIG_FILE)))
      .config,
  };
}
