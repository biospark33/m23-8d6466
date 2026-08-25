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
 * tier points at the same file. That test is on the resolved dir's TRAILING
 * SEGMENTS, not on `resolve(DEFAULT_RUNS_DIR)`: the constant is relative, so
 * resolving it asks about the CALLER's cwd. `fleet dispatch` from /home/x with
 * no `--dir` matched and reserved into /home/x/.sandbox/cost-ledger.db, while
 * `sandbox-teardown --dir /home/x/.sandbox/runs` run from /srv did not match
 * (there `resolve(".sandbox/runs")` is /srv/.sandbox/runs) and settled into
 * /home/x/.sandbox/runs/cost-ledger.db — one records directory, two ledgers,
 * which is the cwd-split this module exists to eliminate, reintroduced in the
 * comparand after it was fixed in the argument.
 *
 * KNOWN LIMIT — a per-issue cap is now enforced per STORE DIR. `fleet dispatch
 * --dir /srv/runs-a <issue>` and `--dir /srv/runs-b <issue>` write two ledgers,
 * and `capForIssue` is checked against each independently, so one issue admits
 * N x its cap across N directories. The move above is justified in the other
 * direction (a shared parent ledger let caps admit across unrelated fleets),
 * and over-counting is the safe failure while under-counting is the one that
 * spends — this trade is deliberate but it is NOT symmetric, and fixing the
 * cwd accident does not fix it. Worse, the CONFIG stays a sibling at
 * `dirname(dir)`, so two sibling store dirs read ONE operator cost-config.json
 * and enforce its caps twice. The upgrade path is an issue-keyed ledger the
 * store dir cannot partition (a single ledger path derived from the issue's
 * repo identity, or a cap reservation the dispatcher holds centrally); until
 * then, one fleet per issue per box is an operator-side invariant nothing in
 * this file enforces.
 *
 * $QDS_COST_LEDGER_FILE / $QDS_COST_CONFIG_FILE still win, restated here rather
 * than left to CostLedger's own tier because the DEFAULT below is no longer the
 * one CostLedger would pick. An explicit env override is one file for both
 * halves, so it cannot split a run's money either.
 */
import { basename, dirname, join, resolve, sep } from "node:path";

import {
  type CostLedgerDeps,
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
 *
 * The returned value is TRIMMED, not just tested: a padded value
 * (`export QDS_COST_LEDGER_FILE=" /srv/ledger.db "` — a trailing space from an
 * editor, a shell snippet, or `read` without `-r`) used to pass the emptiness
 * check verbatim and open a literal-space filename. Whitespace at either end
 * of an env-var path is never intentional.
 */
function envPath(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * Typed against `CostLedgerDeps` — the constructor's OWN option shape — so a
 * field renamed or retyped there is a compile error here rather than an option
 * silently ignored at runtime: `new CostLedger({ ...costLedgerOpts(dir) })`
 * takes excess and misspelled keys without complaint through the spread, and a
 * dropped `path` is a run whose money lands in the cwd-relative default. Both
 * halves are always set, hence `Required<>`.
 */
/**
 * `.sandbox/runs` as a path SUFFIX (`/.sandbox/runs`), which is what "is this
 * the default layout?" actually means. `resolve(DEFAULT_RUNS_DIR)` answered it
 * against the caller's cwd instead — see the header: the same records directory
 * matched from one cwd and not from another, and the run's money split in two.
 */
const DEFAULT_RUNS_SUFFIX = sep + DEFAULT_RUNS_DIR.split("/").join(sep);

export function costLedgerOpts(storeDir: string): Required<Pick<CostLedgerDeps, "path" | "config">> {
  const dir = resolve(storeDir);
  // The default layout is the one place the ledger stays a sibling.
  const ledgerDir = dir.endsWith(DEFAULT_RUNS_SUFFIX) ? dirname(dir) : dir;
  return {
    path: envPath(process.env.QDS_COST_LEDGER_FILE) ?? join(ledgerDir, basename(DEFAULT_COST_LEDGER_FILE)),
    // An absent cost-config.json falls back to DEFAULT_COST_CONFIG
    // (loadCostConfig maps ENOENT to defaults); an unreadable one still throws
    // — fail-closed preserved. But that throw used to reach a BLOCKED TEARDOWN
    // of a billing box with a remediation that never mentioned the one knob
    // that unblocks it, so the override name is appended here (still throwing;
    // the caller decides what to do). loadCostConfig's own remediations are
    // untouched — this is the shared-resolution layer speaking about ITS env.
    config: (() => {
      try {
        return loadCostConfig(
          envPath(process.env.QDS_COST_CONFIG_FILE) ?? join(dirname(dir), basename(DEFAULT_COST_CONFIG_FILE)),
        ).config;
      } catch (e) {
        const err = e as { code?: string; remediation?: string };
        if (err.code === "cost-config-unreadable" || err.code === "cost-config-invalid") {
          err.remediation = `${err.remediation ?? "fix or remove that file"} — or point $QDS_COST_CONFIG_FILE at a readable config to proceed`;
        }
        throw e;
      }
    })(),
  };
}
