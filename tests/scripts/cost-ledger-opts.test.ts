/**
 * F022 — `scripts/lib/cost-ledger-opts.ts` had no test file at all, while
 * `fleet.ts`, `sandbox-teardown.ts`, `sandbox-reap.ts` and `qds-cost.ts` all
 * route their money through it, so it runs on every destructive verb.
 *
 * The three things covered here are the three that can lose accounting:
 *
 *  1. two CLIs racing the first post-move run — one must publish, the other must
 *     not clobber it, and neither may end up reading an EMPTY new ledger;
 *  2. a lockfile left by a crashed holder must age out, or every later
 *     invocation degrades to the legacy path forever;
 *  3. a failed `VACUUM INTO` must fall back to the legacy path cleanly, leaving
 *     no `*.migrating.*.tmp` corpse and no held lock — `catch { return false }`
 *     downgrades a broken migration to "use the legacy path" SILENTLY, so
 *     nothing else would notice the debris.
 *
 * Real files, real `bun:sqlite`, real subprocesses for the race. The store dir
 * is deliberately NOT `.sandbox/runs` — the migration only runs for the
 * non-default layout, which is the layout the relocation orphaned.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { costLedgerOpts } from "../../scripts/lib/cost-ledger-opts.ts";

/**
 * Absolute path to the module under test, for the subprocess runner the race
 * case writes. Anchored on `import.meta.dir`, NOT `process.cwd()` — the cwd is
 * whatever `bun test` was launched from and the import would silently miss from
 * anywhere but the repo root.
 */
const MODULE_PATH = join(import.meta.dir, "..", "..", "scripts", "lib", "cost-ledger-opts.ts");

const LEDGER = "cost-ledger.db";

let base: string;
let storeDir: string;
let legacyPath: string;
let derivedPath: string;
const savedEnv: Record<string, string | undefined> = {};

/** A tiny real SQLite ledger with one identifiable row. */
function seedLegacy(rows: number): void {
  const db = new Database(legacyPath, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("CREATE TABLE IF NOT EXISTS spend (id INTEGER PRIMARY KEY, cents INTEGER)");
  for (let i = 1; i <= rows; i++) db.exec(`INSERT INTO spend (id, cents) VALUES (${i}, ${i * 100})`);
  db.close();
}

function countRows(path: string): number {
  const db = new Database(path, { readonly: true });
  try {
    return (db.query("SELECT COUNT(*) AS n FROM spend").get() as { n: number }).n;
  } finally {
    db.close();
  }
}

/** Any leftover `<ledger>.migrating.<pid>.tmp` snapshot corpse. */
function tmpCorpses(): string[] {
  return readdirSync(storeDir).filter((f) => f.includes(".migrating."));
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "cost-ledger-opts-"));
  // NOT `.sandbox/runs`: the default layout skips the migration entirely.
  storeDir = join(base, "runs-prod");
  mkdirSync(storeDir, { recursive: true });
  legacyPath = join(base, LEDGER);
  derivedPath = join(storeDir, LEDGER);
  for (const k of ["QDS_COST_LEDGER_FILE", "QDS_COST_CONFIG_FILE"]) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(base, { recursive: true, force: true });
});

describe("costLedgerOpts — concurrent migration", () => {
  test("racing processes: one publishes, nobody clobbers, all read the same money", async () => {
    seedLegacy(7);

    // A real race: four separate bun processes entering migrateOrFallback at
    // the same instant against one store dir. In-process calls cannot exercise
    // the O_EXCL lock, because the second call would just see the published
    // destination.
    const runner = join(base, "resolve.ts");
    writeFileSync(
      runner,
      `import { costLedgerOpts } from ${JSON.stringify(MODULE_PATH)};\nprocess.stdout.write(costLedgerOpts(process.argv[2]).path);\n`,
      "utf8",
    );

    const procs = Array.from({ length: 4 }, () =>
      Bun.spawn(["bun", runner, storeDir], { stdout: "pipe", stderr: "pipe" }),
    );
    const paths = await Promise.all(
      procs.map(async (p) => {
        const out = await new Response(p.stdout).text();
        await p.exited;
        return out;
      }),
    );

    // Every process must land on real money: either the published destination
    // or the legacy file it was copied from. An empty new ledger is the one
    // outcome this module exists to prevent.
    for (const p of paths) {
      expect([derivedPath, legacyPath]).toContain(p);
      expect(countRows(p)).toBe(7);
    }
    // At least one process won the lock and published.
    expect(existsSync(derivedPath)).toBe(true);
    expect(countRows(derivedPath)).toBe(7);
    // The legacy file is NEVER moved or truncated — it is the operator's backup.
    expect(countRows(legacyPath)).toBe(7);
    // No debris: no snapshot temp, no held lock.
    expect(tmpCorpses()).toEqual([]);
    expect(existsSync(`${derivedPath}.migrating`)).toBe(false);
  }, 20_000);

  test("an already-published ledger is not re-migrated or clobbered", () => {
    seedLegacy(2);
    expect(costLedgerOpts(storeDir).path).toBe(derivedPath);

    // Spend recorded AFTER the migration must survive a later resolution: the
    // destination's existence is proof of a completed migration, not a rival.
    const db = new Database(derivedPath);
    db.exec("INSERT INTO spend (id, cents) VALUES (99, 9900)");
    db.close();

    expect(costLedgerOpts(storeDir).path).toBe(derivedPath);
    expect(countRows(derivedPath)).toBe(3);
  });
});

describe("costLedgerOpts — migration lockfile", () => {
  test("a stale lockfile is reclaimed and the migration proceeds", () => {
    seedLegacy(4);
    const lockPath = `${derivedPath}.migrating`;
    writeFileSync(lockPath, "", { mode: 0o600 });
    // Older than MIGRATE_LOCK_MAX_AGE_MS (30s): a crashed holder.
    const old = new Date(Date.now() - 120_000);
    utimesSync(lockPath, old, old);

    expect(costLedgerOpts(storeDir).path).toBe(derivedPath);
    expect(countRows(derivedPath)).toBe(4);
    expect(existsSync(lockPath)).toBe(false);
    expect(tmpCorpses()).toEqual([]);
  });

  test("a FRESH lockfile is respected — the legacy path is read, never an empty ledger", () => {
    seedLegacy(4);
    const lockPath = `${derivedPath}.migrating`;
    writeFileSync(lockPath, "", { mode: 0o600 });

    // Bounded wait (2s) expires with the lock still held by a live racer.
    expect(costLedgerOpts(storeDir).path).toBe(legacyPath);
    expect(existsSync(derivedPath)).toBe(false);
    // The waiter must not have stolen or removed a live holder's lock.
    expect(existsSync(lockPath)).toBe(true);
    rmSync(lockPath, { force: true });
  }, 15_000);
});

describe("costLedgerOpts — VACUUM INTO failure", () => {
  test("a legacy file SQLite cannot read falls back cleanly, leaving no temp corpse", () => {
    // A regular file that is not a database: statSync().isFile() passes, so the
    // migration is attempted and `VACUUM INTO` is what fails.
    writeFileSync(legacyPath, "this is not a sqlite database\n", "utf8");

    expect(costLedgerOpts(storeDir).path).toBe(legacyPath);
    // Degraded-but-correct: no half-published destination.
    expect(existsSync(derivedPath)).toBe(false);
    // The failure path must not leave a `.migrating.<pid>.tmp` behind, and must
    // not leave the lock held — the next invocation has to be able to retry.
    expect(tmpCorpses()).toEqual([]);
    expect(existsSync(`${derivedPath}.migrating`)).toBe(false);
  });
});
