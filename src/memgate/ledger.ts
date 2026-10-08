/**
 * M2.1 memory gateway — the INSERT-only issuance/revocation ledger.
 *
 * bun:sqlite, mirror of src/audit/link-store.ts postures:
 *  - append-only enforced IN SQLITE (RAISE(ROLLBACK) triggers on UPDATE/DELETE
 *    of both tables; link-store.ts:245-248 idiom) — this module contains no
 *    UPDATE or DELETE statement;
 *  - DIGESTS ONLY at rest: the `digest` column is sha256 of the presented
 *    material; key/token plaintext is never persisted (INV-MG-6);
 *  - the writable open creates (dir 0700 via fs-atomic's assertDirMode0700,
 *    file 0600, exclusive-create probe — refuse at startup, name the
 *    primitive, never degrade; run-record.ts:1357 discipline);
 *  - `openReadOnly` is the fail-closed reader: no-create probe ("r", never
 *    O_CREAT) → fd HELD → no-CREATE sqlite attach → post-attach inode
 *    re-stat → schema assert (link-store.ts:832 discipline). bun:sqlite's
 *    `new Database(path)`
 *    CREATES the file when absent (link-store.ts:25-27 trap), so the read
 *    path never opens by path without the probe. ANY fault — absent,
 *    unreadable, replaced, corrupt, schema-drifted — refuses with the single
 *    closed-set reason `ledger-unreadable`, and every opened fd is closed on
 *    every path. It NEVER creates.
 */

import { Database } from "bun:sqlite";
import { chmodSync, closeSync, fstatSync, openSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

import { assertDirMode0700, rmQuiet } from "../providers/fs-atomic.ts";
import { MemgateError, resolveMemgateLedgerPath } from "./schemas.ts";

export type MemgateKeyKind = "per-run" | "agent";

/** Row of `memgate_issuance` — snake_case columns, exactly the table's shape. */
export interface MemgateIssuanceRow {
  token_id: string;
  kind: MemgateKeyKind;
  digest: string;
  claims_json: string;
  run_id: string | null;
  created_at_ms: number;
  expires_at_ms: number | null;
}

/** `recordIssuance` input — the table's columns, camelCase at the module edge. */
export interface MemgateIssuanceInput {
  tokenId: string;
  kind: MemgateKeyKind;
  digest: string;
  claimsJson: string;
  runId: string | null;
  createdAtMs: number;
  expiresAtMs: number | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS memgate_issuance (
  token_id      TEXT PRIMARY KEY,
  kind          TEXT NOT NULL CHECK(kind IN ('per-run','agent')),
  digest        TEXT NOT NULL,
  claims_json   TEXT NOT NULL,
  run_id        TEXT,
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER
);
CREATE TABLE IF NOT EXISTS memgate_revocations (
  token_id      TEXT PRIMARY KEY,
  revoked_at_ms INTEGER NOT NULL,
  outcome       TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS memgate_issuance_no_update
BEFORE UPDATE ON memgate_issuance
BEGIN SELECT RAISE(ROLLBACK, 'memgate_issuance is append-only (INV-MG-4)'); END;
CREATE TRIGGER IF NOT EXISTS memgate_issuance_no_delete
BEFORE DELETE ON memgate_issuance
BEGIN SELECT RAISE(ROLLBACK, 'memgate_issuance is append-only (INV-MG-4)'); END;
CREATE TRIGGER IF NOT EXISTS memgate_revocations_no_update
BEFORE UPDATE ON memgate_revocations
BEGIN SELECT RAISE(ROLLBACK, 'memgate_revocations is append-only (INV-MG-4)'); END;
CREATE TRIGGER IF NOT EXISTS memgate_revocations_no_delete
BEFORE DELETE ON memgate_revocations
BEGIN SELECT RAISE(ROLLBACK, 'memgate_revocations is append-only (INV-MG-4)'); END;
`;

const ISSUANCE_COLUMNS = "token_id, kind, digest, claims_json, run_id, created_at_ms, expires_at_ms";
const INSERT_ISSUANCE = `INSERT INTO memgate_issuance (${ISSUANCE_COLUMNS}) VALUES (?,?,?,?,?,?,?)`;
const SELECT_ISSUANCE = `SELECT ${ISSUANCE_COLUMNS} FROM memgate_issuance WHERE token_id = ?`;
const INSERT_REVOCATION = "INSERT INTO memgate_revocations (token_id, revoked_at_ms, outcome) VALUES (?,?,?)";
const SELECT_REVOCATION = "SELECT token_id, revoked_at_ms, outcome FROM memgate_revocations WHERE token_id = ?";

function detail(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function unwritable(path: string, e: unknown): MemgateError {
  return new MemgateError(
    "ledger-unwritable",
    `memgate ledger at ${path} could not be opened for writing (${detail(e)})`,
    "check the directory of QDS_MEMGATE_LEDGER is writable and 0700, the disk is not full, and the ledger is not locked by another process, then retry; nothing was recorded",
  );
}

function unreadable(path: string, e: unknown): MemgateError {
  return new MemgateError(
    "ledger-unreadable",
    `memgate ledger at ${path} is unreadable (${detail(e)}) — the read path never creates one`,
    "point QDS_MEMGATE_LEDGER at an existing memgate ledger (a writable open creates it on first issuance); never hand-create the file",
  );
}

/**
 * Prove the filesystem honors the primitives the ledger's posture needs, at
 * construction — exclusive create at 0600, and a second exclusive create
 * refused. Refuse at startup naming the primitive, never degrade mid-life
 * (run-record.ts:1357 posture, scoped to the primitives this module uses).
 */
function assertExclusiveCreateSupported(dir: string): void {
  const probe = join(dir, `.memgate-probe-${process.pid}-${Math.floor(Math.random() * 0xffffffff).toString(16)}`);
  let fd: number;
  try {
    fd = openSync(probe, "wx", 0o600);
  } catch (e) {
    throw unwritable(dir, `exclusive-create probe failed: ${detail(e)}`);
  }
  try {
    try {
      closeSync(fd);
    } catch {
      // close(2) consumes the descriptor either way; the probes below decide.
    }
    const mode = statSync(probe).mode & 0o777;
    if (mode !== 0o600) {
      throw new MemgateError(
        "ledger-unwritable",
        `filesystem under ${dir} does not honor mode 0600 on exclusive create (got 0${mode.toString(8)})`,
        `fix the mount/umask for QDS_MEMGATE_LEDGER's directory, or choose another — the ledger refuses to run 0644`,
      );
    }
    let secondRefused = false;
    try {
      const second = openSync(probe, "wx", 0o600);
      try {
        closeSync(second); // F-012: the not-honored path still closes what it opened
      } catch {
        // close(2) consumes the descriptor either way
      }
    } catch {
      secondRefused = true; // EEXIST — the good path
    }
    if (!secondRefused) {
      throw new MemgateError(
        "ledger-unwritable",
        `filesystem under ${dir} does not honor exclusive create (O_EXCL) — the ledger cannot guard its own file`,
        "put QDS_MEMGATE_LEDGER on a filesystem that supports O_EXCL",
      );
    }
  } catch (e) {
    // A probe vanished mid-proof (ENOENT et al.) is the same refusal class —
    // never a raw fs error escaping the constructor (F-020).
    if (e instanceof MemgateError) throw e;
    throw unwritable(dir, e);
  } finally {
    rmQuiet(probe);
  }
}

/**
 * Dir 0700 (fs-atomic's one copy, proved) + file 0600 (created-if-absent,
 * chmod'd, proved). Returns whether THIS call created the file — the exclusive
 * `"ax"` probe answers it at the kernel, not via an existsSync race (R2-F-011).
 */
function assertLedgerPosture(path: string): { createdHere: boolean } {
  const dir = dirname(path);
  try {
    assertDirMode0700(dir, (octal) => new MemgateError(
      "ledger-unwritable",
      `memgate ledger dir ${dir} is mode 0${octal}, not 0700`,
      `chmod 700 ${dir} or point QDS_MEMGATE_LEDGER elsewhere`,
    ));
  } catch (e) {
    if (e instanceof MemgateError) throw e;
    throw unwritable(dir, e);
  }
  assertExclusiveCreateSupported(dir);
  let fd: number | undefined;
  let createdHere = false;
  try {
    try {
      fd = openSync(path, "ax", 0o600); // exclusive create at 0600; never truncates
      createdHere = true;
    } catch (e) {
      if (!detail(e).includes("EEXIST")) throw e;
      fd = openSync(path, "a", 0o600); // preexisting — plain append open
    }
    chmodSync(path, 0o600);
    const fileMode = statSync(path).mode & 0o777;
    if (fileMode !== 0o600) {
      throw new MemgateError(
        "ledger-unwritable",
        `memgate ledger file ${path} is mode 0${fileMode.toString(8)}, not 0600`,
        `chmod 600 ${path} — the ledger refuses to hold key digests on a wider file`,
      );
    }
  } catch (e) {
    if (e instanceof MemgateError) throw e;
    throw unwritable(path, e);
  } finally {
    try {
      if (fd !== undefined) closeSync(fd);
    } catch {
      // close(2) consumes the descriptor either way.
    }
  }
  return { createdHere };
}

/** Construction options for the writable handle. */
export interface MemgateLedgerOptions {
  /** Clock for `revoked_at_ms` stamps (default `Date.now`) — injectable under a frozen test clock. */
  now?: () => number;
}

export class MemgateLedger {
  private readonly db: Database;
  private readonly path: string;
  private readonly writable: boolean;
  private readonly now: () => number = Date.now;

  /** Writable open (creating on first use) — the issuer's handle. */
  constructor(path: string, opts?: MemgateLedgerOptions);
  /** Attach to an already-verified connection (openReadOnly). Mutations refuse. */
  constructor(db: Database, path: string);
  constructor(source: string | Database, pathOrOpts?: string | MemgateLedgerOptions) {
    if (typeof source === "string") {
      const opts = typeof pathOrOpts === "string" ? undefined : pathOrOpts;
      this.path = source;
      this.writable = true;
      this.now = opts?.now ?? Date.now;
      let createdHere = false;
      let db: Database | undefined;
      try {
        ({ createdHere } = assertLedgerPosture(source));
        db = new Database(source);
        db.exec("PRAGMA busy_timeout = 5000;");
        db.exec(SCHEMA);
      } catch (e) {
        try {
          db?.close();
        } catch {
          // the constructor fault below is the diagnosis
        }
        // "refusal creates nothing" (F-021): remove ONLY a file THIS
        // constructor exclusively created AND only while it is still a
        // zero-byte skeleton — a populated ledger (another writer attached
        // between create and failure, or our own schema exec landed) is never
        // deleted (R2-F-011).
        if (
          createdHere &&
          statSync(source, { throwIfNoEntry: false })?.size === 0
        ) {
          rmQuiet(source);
        }
        if (e instanceof MemgateError) throw e;
        throw unwritable(source, e);
      }
      this.db = db;
      return;
    }
    if (typeof pathOrOpts !== "string") throw new Error("MemgateLedger attach constructor requires a path");
    this.path = pathOrOpts;
    this.writable = false;
    this.db = source;
  }

  private assertWritable(): void {
    if (this.writable) return;
    throw new MemgateError(
      "ledger-unwritable",
      `ledger at ${this.path} is open read-only`,
      "open the writable handle (new MemgateLedger(path)) to record issuance or revocation",
    );
  }

  recordIssuance(input: MemgateIssuanceInput): void {
    this.assertWritable();
    try {
      this.db
        .prepare(INSERT_ISSUANCE)
        .run(input.tokenId, input.kind, input.digest, input.claimsJson, input.runId, input.createdAtMs, input.expiresAtMs);
    } catch (e) {
      // Issuance PK collision: the token id already exists — the append-only
      // invariant held, so a distinct diagnosis, not a fatal mislabeled as
      // unwritable (R2-F-009; recordRevocation maps the same race to
      // already-gone).
      if (detail(e).includes("UNIQUE constraint failed")) {
        throw new MemgateError(
          "token-id-collision",
          `issuance for token id ${input.tokenId} already exists in ${this.path}`,
          "retry with fresh randomness — the id space collided, nothing was corrupted",
        );
      }
      throw unwritable(this.path, e);
    }
  }

  /** Prior-state aware: a second revocation of the same token is `already-gone`. */
  recordRevocation(tokenId: string, outcome: string): "revoked" | "already-gone" {
    this.assertWritable();
    try {
      const existing = this.db.prepare(SELECT_REVOCATION).get(tokenId);
      if (existing !== undefined && existing !== null) return "already-gone";
      this.db.prepare(INSERT_REVOCATION).run(tokenId, this.now(), outcome);
      return "revoked";
    } catch (e) {
      // Concurrent double-revoke: the other writer's INSERT won the PRIMARY
      // KEY race — the revocation IS recorded, so report prior-state
      // semantics, not a fatal mislabeled as unwritable (F-011).
      if (detail(e).includes("UNIQUE constraint failed")) return "already-gone";
      throw unwritable(this.path, e);
    }
  }

  /** Fail-closed: a read fault is a thrown `ledger-unreadable`, never a false. */
  isRevoked(tokenId: string): boolean {
    try {
      const row = this.db.prepare(SELECT_REVOCATION).get(tokenId);
      return row !== undefined && row !== null;
    } catch (e) {
      throw unreadable(this.path, e);
    }
  }

  getIssuance(tokenId: string): MemgateIssuanceRow | undefined {
    try {
      const row = this.db.prepare(SELECT_ISSUANCE).get(tokenId);
      return (row ?? undefined) as MemgateIssuanceRow | undefined;
    } catch (e) {
      throw unreadable(this.path, e);
    }
  }

  /** Admin list — every issuance row, oldest first; optionally by kind. */
  listIssued(kind?: MemgateKeyKind): MemgateIssuanceRow[] {
    try {
      if (kind === undefined) {
        return this.db
          .prepare(`SELECT ${ISSUANCE_COLUMNS} FROM memgate_issuance ORDER BY created_at_ms`)
          .all() as MemgateIssuanceRow[];
      }
      return this.db
        .prepare(`SELECT ${ISSUANCE_COLUMNS} FROM memgate_issuance WHERE kind = ? ORDER BY created_at_ms`)
        .all(kind) as MemgateIssuanceRow[];
    } catch (e) {
      throw unreadable(this.path, e);
    }
  }

  close(): void {
    this.db.close();
  }
}

/**
 * The fail-closed reader (openAuditStoreForWalk discipline, link-store.ts:832):
 * no-create probe with the fd HELD, inode re-stat AFTER the sqlite attach,
 * schema asserted — over a no-CREATE sqlite attach (`{readwrite: true}`, the
 * only flag pair that keeps "never creates" true; a bare new Database(path)
 * MATERIALIZES an absent file). Every refusal is `ledger-unreadable`; every
 * fd — and the half-bound database — is closed on every path.
 */
export function openReadOnly(path: string): MemgateLedger {
  const resolved = resolveMemgateLedgerPath(path);
  let fd: number | undefined;
  try {
    fd = openSync(resolved, "r"); // never O_CREAT — the probe itself cannot create
  } catch (e) {
    try {
      if (fd !== undefined) closeSync(fd);
    } catch {
      // the refusal below is the diagnosis
    }
    throw unreadable(resolved, e);
  }
  let probeIno: number;
  try {
    probeIno = fstatSync(fd).ino;
  } catch (e) {
    try {
      closeSync(fd);
    } catch {
      // the refusal below is the diagnosis
    }
    throw unreadable(resolved, e);
  }
  let db: Database | undefined;
  try {
    // `{ readwrite: true }` maps onto zero open flags — READWRITE without
    // CREATE, the ONLY pair that cannot materialize a missing file
    // (link-store.ts:754-764).
    db = new Database(resolved, { readwrite: true });
    db.exec("PRAGMA busy_timeout = 5000;");
    // bun:sqlite attached BY PATH — re-stat NOW that it is bound: any
    // probe→attach swap (rename-over) reads the replaced file's inode here,
    // closing the window an fd-pair compare leaves open (F-012).
    if (statSync(resolved).ino !== probeIno) {
      throw unreadable(resolved, `the ledger was removed or replaced between the probe and the attach (probed inode ${String(probeIno)})`);
    }
    // `new Database` is LAZY — corruption surfaces on the first statement
    // that reads the header, which is this one, inside this try.
    const bound = db;
    const tableOf = (name: string): unknown =>
      bound.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
    if (tableOf("memgate_issuance") == null || tableOf("memgate_revocations") == null) {
      throw unreadable(resolved, "the file is a readable SQLite database but carries no memgate schema — it was not written by this module");
    }
    return new MemgateLedger(db, resolved);
  } catch (e) {
    try {
      db?.close();
    } catch {
      // the original error is the diagnosis
    }
    if (e instanceof MemgateError) throw e;
    throw unreadable(resolved, e);
  } finally {
    try {
      closeSync(fd);
    } catch {
      // guarded close on every exit path
    }
  }
}
