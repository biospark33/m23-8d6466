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
import {
  closeSync,
  existsSync,
  fstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";

import { Database } from "bun:sqlite";

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

/**
 * One-line best-effort stderr note (fd-2 style), never thrown from — and never
 * FATAL either. A write to a broken or closed fd 2 does not throw from
 * `process.stderr.write`; it reports ASYNCHRONOUSLY as an `error` event on the
 * stream, which the try/catch below cannot see. An unhandled `error` event on a
 * stream takes the whole process down, so the note needs a handler of its own.
 * Attached ONCE, not per call: per-call listeners would accumulate toward
 * `setMaxListeners` and change nothing about the swallow. Swallowing stderr
 * errors process-wide is the point — diagnostics are the one channel whose own
 * failure must never become the process's failure.
 */
let stderrGuarded = false;
function noteStderr(line: string): void {
  if (!stderrGuarded) {
    stderrGuarded = true;
    process.stderr.on("error", () => {});
  }
  try {
    // Through the process stream rather than raw `writeSync(2)`: the same fd 2
    // in production, and `process.stderr.write` is the seam tests capture.
    process.stderr.write(`${line}\n`);
  } catch {
    // Diagnostics only; resolution must not fail over a note.
  }
}

/** Block this thread briefly — same primitive run-record.ts's lock wait uses. */
function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** How long a migration lockfile may age before a later process reclaims it. */
const MIGRATE_LOCK_MAX_AGE_MS = 30_000;
/** Bounded wait for a contended migration lock before falling back to legacy. */
const MIGRATE_LOCK_WAIT_MS = 2_000;

/**
 * L5 MIGRATION — one-time, additive. When the RESOLVED ledger path does not
 * exist yet but the LEGACY sibling `<parent>/cost-ledger.db` beside the records
 * directory does, copy it to the new location. Non-default store dirs had their
 * money orphaned by the relocation: dispatch reserved against a brand-new
 * empty ledger while every reservation and settled box hour sat unread in the
 * old sibling — `capForIssue` saw zero spend and re-admitted spend that was
 * already blocked, which is the under-counting direction that SPENDS.
 *
 * Fail-safe on every axis:
 *  - the legacy file is NEVER deleted or moved — it stays as the operator's
 *    backup and as the fallback below forever;
 *  - an env override wins outright (`$QDS_COST_LEDGER_FILE`) and skips both the
 *    migration and the check — an explicit path is deliberate, no second-
 *    guessing it;
 *  - any failure at any point falls back to READING THE LEGACY PATH rather than
 *    proceeding against an empty new ledger — degraded-but-correct beats
 *    silently-wrong.
 *
 * CONCURRENT-SAFE by construction (two CLIs racing the first post-move run):
 *  - an interprocess O_EXCL lockfile serializes the migration, aged out by
 *    mtime so a crashed holder cannot deadlock every later invocation — and a
 *    lock that cannot be acquired within the bounded wait falls back to
 *    READING THE LEGACY, which is always the same money;
 *  - stale locks are reclaimed with an OWNERSHIP-PRESERVING protocol: the shared
 *    path is renamed to a private claim, verified by inode and content, and
 *    removed only if it is the exact stale file inspected. A successor lock
 *    that lands in the gap is captured, detected, and restored to the shared
 *    path instead of being unlinked. The release is fenced on inode and
 *    content so a slow process never removes a faster successor's live lock;
 *  - the copy is WAL-AWARE: the ledger opens `journal_mode = WAL`, so a raw
 *    file copy of the main db alone can miss rows still committed in the
 *    `-wal` sidecar (and a copy of a hot db is a torn read besides). The
 *    snapshot is taken through SQLite itself — a read-only connection
 *    `VACUUM INTO`ing a complete, consistent image — never by copying bytes;
 *  - publication is ATOMIC: the snapshot lands at a pid-suffixed temp path and
 *    is renamed into place, so no reader ever observes a half-written ledger,
 *    and the destination's existence after the lock is PROOF a migration
 *    completed (re-checked under the lock), never a side effect of one.
 */
function migrateOrFallback(ledgerPath: string, legacyPath: string): string {
  if (existsSync(ledgerPath) || !existsSync(legacyPath)) return ledgerPath;
  let isRegularFile = false;
  try {
    isRegularFile = statSync(legacyPath).isFile();
  } catch {
    isRegularFile = false;
  }
  if (isRegularFile) {
    // BEFORE the lock: the lockfile is a sibling of the destination, so the
    // destination's directory must exist or the O_EXCL acquire itself ENOENTs
    // and every contender waits out the bounded window for nothing.
    try {
      mkdirSync(dirname(ledgerPath), { recursive: true });
    } catch {
      // The body's own failure path reports this properly.
    }
    if (withMigrationLock(ledgerPath, legacyPath)) {
      noteStderr(
        `note: migrated cost ledger ${legacyPath} -> ${ledgerPath} (legacy file kept in place; remove it once you have verified the new location)`,
      );
      return ledgerPath;
    }
    // The lock could not be acquired (a live racer holds it past the bounded
    // wait): reading the LEGACY location is the same money, so that is the
    // safe fall-through below — not an empty new ledger.
  }
  noteStderr(
    `warning: could not migrate cost ledger ${legacyPath} to ${ledgerPath} — reading the LEGACY location so existing accounting is not silently dropped`,
  );
  return legacyPath;
}

/** The per-attempt VACUUM destination, pid-stamped so racers never share one. */
function tmpPath(ledgerPath: string): string {
  return `${ledgerPath}.migrating.${process.pid}.tmp`;
}

/** Test seam for the migration lock protocol. Not for production use. */
export interface MigrationLockTestHooks {
  /**
   * Called after a stale lock has been inspected (stat + content read) and
   * before it is renamed to a private claim path. Lets tests deterministically
   * land a successor lock in the race window the ownership-preserving protocol
   * is meant to close.
   */
  beforeStaleClaim?: () => void;
}

/**
 * Run the migration body under an interprocess lock. True when the ledger was
 * published (by this process or a racer that held the lock first); false when
 * the lock could not be acquired — the caller falls back to the legacy read.
 *
 * OWNERSHIP-PRESERVING PROTOCOL: the shared lock path is never removed by
 * anyone who cannot prove they are removing the file they inspected. A stale
 * lock is reclaimed by renaming it to a private, pid-and-nonce-stamped claim
 * path, then verifying inode and content before unlinking only the claim. If a
 * successor created a fresh lock in the gap, the rename captures the successor's
 * file; the verification fails, and the very file is restored to the shared
 * path with `linkSync` (restore-if-absent) so the successor's own fenced
 * release stays valid. The release is fenced on both inode and content: a
 * process whose lock was reclaimed by a faster racer will not unlink the
 * racer's live lock.
 */
function withMigrationLock(
  ledgerPath: string,
  legacyPath: string,
  hooks?: MigrationLockTestHooks,
): boolean {
  const lockPath = `${ledgerPath}.migrating`;
  const deadline = Date.now() + MIGRATE_LOCK_WAIT_MS;
  // THIS acquisition's identity. `ownIno === -1` means "we hold no lock" and
  // keeps the fenced release from touching anything.
  let ownIno = -1;
  let ownContent = "";
  for (;;) {
    try {
      // `wx` creates atomically; `fstatSync` on our own fd records the inode
      // of the file THIS call created, with no window for a replacement to be
      // measured instead.
      const fd = openSync(lockPath, "wx", 0o600);
      try {
        ownContent = `${process.pid}:${randomUUID()}`;
        writeFileSync(fd, ownContent);
        ownIno = fstatSync(fd).ino;
      } catch (writeErr) {
        // A write failure strands an empty lock that no later waiter can ever
        // attribute to a live holder. Remove the file we just created — by
        // inode, so a replacement that landed in the microsecond between the
        // failed write and this cleanup is not deleted.
        try {
          if (ownIno === -1 || fstatSync(fd).ino === ownIno) rmSync(lockPath, { force: true });
        } catch {
          // Empty lock will be reclaimed as stale (no pid in content) later.
        }
        throw writeErr;
      } finally {
        closeSync(fd);
      }
      // Re-verify identity through the path: this process may have been
      // suspended between the `wx` and the content write for longer than the
      // stale window, and a waiter could have reclaimed the empty lock in the
      // meantime. `statSync(lockPath).ino === ownIno` answers "does the path
      // still resolve to the file we created?".
      let stillOurs = false;
      try {
        stillOurs = statSync(lockPath).ino === ownIno;
      } catch {
        stillOurs = false;
      }
      if (!stillOurs) {
        ownIno = -1; // do not unlink the successor's lock in the finally
        throw Object.assign(
          new Error(`migration lock ${lockPath}: created lock was reclaimed before content landed`),
          { code: "EEXIST" },
        );
      }
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;

      // Stale reclaim with rename-to-private-claim. A bare stat-then-rmSync
      // has an uncloseable gap: a successor can create a fresh lock after the
      // stat and before the rm, and the stale remover then deletes the
      // successor's lock and creates its own. Both processes enter the body.
      let claimed = false;
      try {
        const st = statSync(lockPath);
        const age = Date.now() - st.mtimeMs;
        if (age > MIGRATE_LOCK_MAX_AGE_MS) {
          const raw = readFileSync(lockPath, "utf8");
          hooks?.beforeStaleClaim?.();
          const claimPath = `${lockPath}.claim.${process.pid}.${randomUUID()}`;
          try {
            // Atomically move WHATEVER is at `lockPath` onto a private name.
            // A second racer's rename fails ENOENT; it cannot clobber what we
            // captured, and it cannot capture our claim.
            renameSync(lockPath, claimPath);
            claimed = true;
          } catch (renameErr) {
            if ((renameErr as NodeJS.ErrnoException).code !== "ENOENT") throw renameErr;
            // Another racer claimed first or the lock was released. Fall through
            // to the bounded wait; the path is live again.
          }
          if (claimed) {
            if (statSync(claimPath).ino === st.ino && readFileSync(claimPath, "utf8") === raw) {
              // Genuinely the stale lock we inspected: remove it by its private
              // name and retry immediately.
              rmSync(claimPath, { force: true });
              continue;
            }
            // We captured a live replacement's lock that landed in the gap.
            // Restore the very inode to the shared path so the replacement's
            // fenced release still recognizes it. `linkSync` is restore-if-
            // absent: EEXIST means a new holder already took `lockPath`, and we
            // can simply discard the superseded claim.
            try {
              linkSync(claimPath, lockPath);
            } catch (restoreErr) {
              if ((restoreErr as NodeJS.ErrnoException).code !== "EEXIST") throw restoreErr;
            }
            rmSync(claimPath, { force: true });
            // Fall through to the bounded wait: the live successor (or a new
            // holder) keeps the path.
          }
        }
      } catch (err) {
        // Once we own a claimed file we are holding either the stale lock or a
        // live replacement's. Any failure past that point must be loud: failing
        // closed here leaves `lockPath` vacant, which would let the next
        // acquirer enter the body concurrently with whatever we displaced.
        if (claimed) throw err;
        // A vanish between the failed `wx` and the stat/read is benign — retry.
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
      if (Date.now() >= deadline) return false;
      sleepMs(50);
    }
  }
  const tmp = tmpPath(ledgerPath);
  try {
    // Re-checked UNDER the lock: the racer that won already published, and
    // its destination is proof of a completed migration — not a rival to
    // clobber.
    if (existsSync(ledgerPath)) return true;
    // A corpse from an earlier life of THIS pid cannot be VACUUMed over
    // (SQLite refuses an existing destination), so clear it first.
    rmSync(tmp, { force: true });
    const src = new Database(legacyPath, { readonly: true });
    try {
      src.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
    } finally {
      src.close();
    }
    renameSync(tmp, ledgerPath);
    return true;
  } catch (e) {
    // The destination stays absent — no half-published ledger — and the temp
    // is removed, not left to age out: a failed VACUUM INTO (a legacy file
    // that is not a database, a full disk) leaves a PARTIAL image there, and
    // the next invocation's pre-rm only covers a reuse of THIS pid. The
    // caller's legacy fallback is still the verdict; removing the corpse is
    // what makes the next invocation's retry a clean one.
    try {
      rmSync(tmp, { force: true });
    } catch {
      // Best effort, like the lock rm below: the temp is pid-stamped, so a
      // rm that fails here still gets cleared by the next same-pid attempt.
    }
    // The fallback is correct but PERMANENT — every later invocation reads the
    // legacy side — so the reason has to be findable. One stderr line, never
    // thrown from: `noteStderr` is the module's own best-effort channel.
    noteStderr(
      `warning: cost ledger migration failed (${e instanceof Error ? e.message : String(e)}); using legacy ${legacyPath}`,
    );
    return false;
  } finally {
    // FENCED release, not an unconditional `rmSync`. If a faster racer
    // reclaimed our lock while we were inside the body, `lockPath` now names
    // the racer's file and removing it would admit a third process. Only
    // unlink when both inode and content prove the path still names the lock
    // this process created.
    try {
      if (ownIno !== -1) {
        let stillOurs = false;
        try {
          stillOurs = statSync(lockPath).ino === ownIno;
        } catch {
          stillOurs = false;
        }
        if (stillOurs) {
          try {
            stillOurs = readFileSync(lockPath, "utf8") === ownContent;
          } catch {
            stillOurs = false;
          }
        }
        if (stillOurs) rmSync(lockPath, { force: true });
      }
    } catch {
      // Best effort: a stuck lockfile ages out via the stale reclaim above.
    }
  }
}

/**
 * EXPOSED FOR TESTING ONLY. Do not call outside tests. Mirrors
 * `withMigrationLock` but accepts hooks that let tests deterministically
 * exercise race windows.
 */
export function __testWithMigrationLock(
  ledgerPath: string,
  legacyPath: string,
  hooks?: MigrationLockTestHooks,
): boolean {
  return withMigrationLock(ledgerPath, legacyPath, hooks);
}

export function costLedgerOpts(storeDir: string): Required<Pick<CostLedgerDeps, "path" | "config">> {
  const dir = resolve(storeDir);
  // The default layout is the one place the ledger stays a sibling.
  const defaultLayout = dir.endsWith(DEFAULT_RUNS_SUFFIX);
  const ledgerDir = defaultLayout ? dirname(dir) : dir;
  const override = envPath(process.env.QDS_COST_LEDGER_FILE);
  const derivedPath = join(ledgerDir, basename(DEFAULT_COST_LEDGER_FILE));
  return {
    // L5: for a NON-default layout the relocation above is the one that
    // orphaned existing accounting, so when the new spot is empty and the old
    // sibling still holds the money, migrate (or read the old side). The
    // DEFAULT layout special case needs no migration — it has always settled
    // into its sibling.
    path:
      override ??
      (defaultLayout
        ? derivedPath
        : migrateOrFallback(derivedPath, join(dirname(dir), basename(DEFAULT_COST_LEDGER_FILE)))),
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
