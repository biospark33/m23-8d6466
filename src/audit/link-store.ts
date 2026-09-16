/**
 * The append-only audit-link store (DF5.3).
 *
 * One immutable row per link-worthy event, written BY ITS EMITTER at the
 * moment of the event, never retroactively (INV-AUDIT-4). Host-side SQLite
 * beside the run records (`.sandbox/audit.db`), so it survives box destruction
 * (§6 item 4). Redelivered emits land on `INSERT … ON CONFLICT DO NOTHING` —
 * a no-op, never an update — keyed `UNIQUE (run_id, hop, event,
 * COALESCE(subject_id,'<none>'))` through the generated `subject_key` column:
 * the literal form from the story's Technical Notes, never a bare
 * `subject_id` UNIQUE, because NULLs are distinct in a SQLite UNIQUE index.
 *
 * The journal stays on SQLite's default DELETE — NEVER WAL — so the store
 * leaves no `-wal`/`-shm` siblings and DF5.4's file-set assertion can be
 * exact. Immutability: BEFORE UPDATE/DELETE triggers that RAISE(ABORT), no
 * update or delete statement in this module. `evidence_digest` is the sha256
 * of the canonicalised subject, computed by the CALLER at emit time — this
 * store never digests — so a rewritten subject reports `evidence-mismatch`.
 *
 * The read path (`openAuditStoreForWalk`) copies DF2.11's no-create
 * discipline and closes the hole a held-fd-only comparison leaves, because
 * `bun:sqlite`'s `new Database(path)` creates the file when absent: probe →
 * hold the fd → re-open by path → compare inodes → bind. The walk path NEVER
 * migrates and NEVER creates: it asserts the schema and fails closed
 * (`audit-store-schema-absent`, INV-AUDIT-6).
 */

import { chmodSync, closeSync, fstatSync, mkdirSync, openSync, statSync } from "node:fs";
import { dirname } from "node:path";

import { Database, type Statement } from "bun:sqlite";

import { log, newRequestId } from "../swarmclaw/log.ts";

/**
 * The ten hops of the audit chain (story hop table, DD-8). `AuditLinkInput`
 * stays wide (`string`) at the provider seam — `src/providers/*` must not
 * import `src/audit` (DF4.2 direction) — and is narrowed here at write time
 * and again by the walker.
 */
export const AUDIT_HOPS = [
  "pr-run",
  "run-issue",
  "run-cost",
  "run-credential",
  "run-box",
  "run-bundle",
  "run-reverify",
  "run-approval",
  "run-gate-evidence",
  "memory-retain-receipt",
] as const;
export type AuditHop = (typeof AUDIT_HOPS)[number];

/**
 * Per-hop event vocabulary, fail-loud at write time (`audit-link-invalid`).
 * The credential/box/bundle hops are the only EMITTED lifecycle hops and take
 * ONLY their vocabulary above; every other hop takes ONLY `walk-observed` —
 * no emitter exists for it (the pr-run/run-reverify/run-approval lifecycle
 * records are not emitted; their digest rows are the walker's
 * first-observation rows), and manufacturing a link for an event that never
 * occurred is what INV-AUDIT-4 forbids.
 */
const HOP_EVENT_VOCABULARY = {
  "run-credential": ["mint", "deliver", "revoke", "verify-revoked"],
  "run-box": ["create", "fill", "setup-gate", "teardown", "reap"],
  "run-bundle": ["bundle-verify", "bundle-fetch"],
  "pr-run": ["walk-observed"],
  "run-issue": ["walk-observed"],
  "run-cost": ["walk-observed"],
  "run-reverify": ["walk-observed"],
  "run-approval": ["walk-observed"],
  "run-gate-evidence": ["walk-observed"],
  "memory-retain-receipt": ["walk-observed"],
} as const satisfies Readonly<Record<AuditHop, readonly string[]>>;

/** The walker's first-observation digest rows. */
export const WALK_OBSERVED_EVENT = "walk-observed";

/** The 8 KiB ceiling on one row's `detail_json` (story Guards/limits). */
const DETAIL_JSON_MAX_BYTES = 8192;

/** The coalesce sentinel behind `subject_key` (schema, fixed by story). */
const SUBJECT_NONE_KEY = "<none>";

/** Wide provider-facing emit shape — see `AUDIT_HOPS` for the seam rationale. */
export interface AuditLinkInput {
  runId: string;
  repoSlug: string;
  requestId: string;
  hop: string;
  event: string;
  subjectId?: string;
  subjectKind?: string;
  evidencePath?: string;
  /** sha256 of the canonicalised subject, computed by the caller at emit time. */
  evidenceDigest: string;
  /** → detail_json, 8 KiB cap (refused larger, never truncated). */
  detail?: unknown;
  /** ISO stamps; occurredAt is the EVENT time. */
  occurredAt: string;
  recordedAt: string;
}

export interface AuditLinkRow extends AuditLinkInput {
  linkId: number;
  hop: AuditHop;
}

export interface AuditStoreWriter {
  record(link: AuditLinkInput): void;
  close(): void;
  readonly path: string;
}

export interface AuditStoreReader {
  /** Ordered by occurred_at, then link_id. */
  linksForRun(runId: string): AuditLinkRow[];
  linkExists(runId: string, hop: string, event: string, subjectId?: string): boolean;
  close(): void;
  readonly path: string;
}

type AuditStoreErrorCode =
  | "audit-store-absent"
  | "audit-store-identity-changed"
  | "audit-store-schema-absent"
  | "audit-link-invalid";

export class AuditStoreError extends Error {
  readonly code: AuditStoreErrorCode;
  /** The literal next command, secrets referenced by env-var NAME, never expanded. */
  readonly remediation: string;

  constructor(code: AuditStoreErrorCode, message: string, remediation: string) {
    super(message);
    this.name = "AuditStoreError";
    this.code = code;
    this.remediation = remediation;
  }
}

/** The store's default path — shared with the walker CLI's existence check. */
export const DEFAULT_AUDIT_DB_FILE = ".sandbox/audit.db";

/**
 * `JSON.stringify` over recursively key-sorted values (arrays keep order), so
 * key order cannot forge an evidence-mismatch. `undefined` canonicalises to
 * `null`; an `undefined` OBJECT member is dropped as `JSON.stringify` drops it.
 */
export function canonicalJson(value: unknown): string {
  if (value === undefined || value === null) return "null";
  if (typeof value !== "object") return JSON.stringify(value) as string;
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${v === undefined ? "null" : canonicalJson(v)}`).join(",")}}`;
}

/** The one digest primitive every emitter composes with `canonicalJson`. */
export function sha256Hex(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS audit_links (
  link_id         INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id          TEXT NOT NULL,
  repo_slug       TEXT NOT NULL,
  request_id      TEXT NOT NULL,
  hop             TEXT NOT NULL,
  event           TEXT NOT NULL,
  subject_id      TEXT,
  subject_kind    TEXT,
  evidence_path   TEXT,
  evidence_digest TEXT NOT NULL,
  detail_json     TEXT,
  occurred_at     TEXT NOT NULL,
  recorded_at     TEXT NOT NULL,
  subject_key     TEXT GENERATED ALWAYS AS (COALESCE(subject_id,'<none>')) VIRTUAL,
  UNIQUE (run_id, hop, event, subject_key)
);
CREATE INDEX IF NOT EXISTS audit_links_run_hop ON audit_links (run_id, hop);
CREATE TRIGGER IF NOT EXISTS audit_links_no_update
BEFORE UPDATE ON audit_links
BEGIN SELECT RAISE(ABORT, 'audit_links is append-only (INV-AUDIT-4)'); END;
CREATE TRIGGER IF NOT EXISTS audit_links_no_delete
BEFORE DELETE ON audit_links
BEGIN SELECT RAISE(ABORT, 'audit_links is append-only (INV-AUDIT-4)'); END;
`;

const INSERT_SQL = `
INSERT INTO audit_links (
  run_id, repo_slug, request_id, hop, event, subject_id, subject_kind,
  evidence_path, evidence_digest, detail_json, occurred_at, recorded_at
) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
ON CONFLICT DO NOTHING`;

function invalidLink(message: string, remediation: string): AuditStoreError {
  return new AuditStoreError("audit-link-invalid", message, remediation);
}

const VOCAB_REMEDIATION =
  "emit the link with a hop from AUDIT_HOPS and that hop's documented event vocabulary (src/audit/link-store.ts HOP_EVENT_VOCABULARY)";

const SCHEMA_ABSENT_REMEDIATION =
  "point QDS_AUDIT_DB at a store created by openAuditStore (write-time init migrates the writer path only; the walk never migrates), then re-run the walk";

/** Fail-loud write-time validation; the digest is validated, never computed. */
function validateAndBind(link: AuditLinkInput): { detailJson: string | null } {
  for (const [field, value] of [
    ["runId", link.runId],
    ["repoSlug", link.repoSlug],
    ["requestId", link.requestId],
    ["occurredAt", link.occurredAt],
    ["recordedAt", link.recordedAt],
  ] as const) {
    if (typeof value !== "string" || value.length === 0) {
      throw invalidLink(`audit link ${field} must be a non-empty string (got ${JSON.stringify(value)})`, `supply ${field} from the emitter's own context`);
    }
  }
  const vocabulary: readonly string[] | undefined = (HOP_EVENT_VOCABULARY as Readonly<Record<string, readonly string[] | undefined>>)[link.hop];
  if (vocabulary === undefined) throw invalidLink(`unknown audit hop ${JSON.stringify(link.hop)}`, VOCAB_REMEDIATION);
  if (!vocabulary.includes(link.event)) {
    throw invalidLink(
      `event ${JSON.stringify(link.event)} is not in hop ${JSON.stringify(link.hop)}'s vocabulary (${vocabulary.join(" | ")})`,
      VOCAB_REMEDIATION,
    );
  }
  if (!/^[0-9a-f]{64}$/.test(link.evidenceDigest)) {
    throw invalidLink(
      `evidenceDigest must be 64 lowercase hex (sha256 of the canonicalised subject), got ${JSON.stringify(link.evidenceDigest)}`,
      "digest the subject with sha256Hex(canonicalJson(subject)) at emit time",
    );
  }
  let detailJson: string | null = null;
  if (link.detail !== undefined) {
    detailJson = JSON.stringify(link.detail);
    const bytes = Buffer.byteLength(detailJson, "utf8");
    if (bytes > DETAIL_JSON_MAX_BYTES) {
      throw invalidLink(`detail_json is ${bytes} bytes — past the 8 KiB cap (refused, never truncated)`, "shrink the detail payload or move the bulk to the artefact the evidence_path names");
    }
  }
  return { detailJson };
}

/**
 * The one structured line per store operation (`audit-link.record` /
 * `audit-store.open`), on success AND refusal paths — an unlogged refusal is
 * an outcome an operator cannot audit. No line carries key material
 * (INV-AUDIT-2): ids, digests, hops, paths and codes only.
 */
function emitLine(entry: { operation: string; requestId: string; durationMs: number; status: "ok" | "error"; message: string } & Record<string, unknown>): void {
  log({ agentId: null, timestamp: new Date().toISOString(), duration: entry.durationMs, ...entry });
}

class SqliteAuditStore implements AuditStoreWriter {
  readonly path: string;
  private readonly db: Database;
  private readonly insert: Statement;

  constructor(path: string) {
    this.path = path;
    // Write-time init ONLY (the walk path never reaches here): mkdir 0700,
    // chmod file 0600, SQLite's default DELETE journal (no journal_mode
    // pragma is ever issued), busy_timeout, idempotent schema inside
    // BEGIN IMMEDIATE so two concurrent first-emits cannot race the CREATEs.
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    chmodSync(dirname(this.path), 0o700);
    const isNew = !statSync(this.path, { throwIfNoEntry: false });
    this.db = new Database(this.path);
    if (isNew) chmodSync(this.path, 0o600); // a pre-existing file keeps its mode
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec(SCHEMA);
      this.db.exec("COMMIT");
    } catch (e) {
      try { this.db.exec("ROLLBACK"); } catch { /* already unwound */ }
      try { this.db.close(); } catch { /* the handle dies with the process */ }
      throw e;
    }
    this.insert = this.db.prepare(INSERT_SQL);
  }

  record(link: AuditLinkInput): void {
    const started = Date.now();
    const { detailJson } = validateAndBind(link);
    const { changes } = this.insert.run(
      link.runId,
      link.repoSlug,
      link.requestId,
      link.hop,
      link.event,
      link.subjectId ?? null,
      link.subjectKind ?? null,
      link.evidencePath ?? null,
      link.evidenceDigest,
      detailJson,
      link.occurredAt,
      link.recordedAt,
    );
    // changes === 0: ON CONFLICT fired on the UNIQUE key — a redelivered emit
    // is a no-op on the coalesce sentinel, never an update (there is no
    // update path in this module to fall into).
    const outcome = changes === 1 ? "inserted" : "duplicate";
    emitLine({
      operation: "audit-link.record", requestId: link.requestId, durationMs: Date.now() - started, status: "ok",
      runId: link.runId, repoSlug: link.repoSlug, hop: link.hop, event: link.event,
      subjectKind: link.subjectKind ?? null, outcome,
      message: `audit link ${outcome}: run ${link.runId} hop ${link.hop}.${link.event}`,
    });
  }

  close(): void {
    this.db.close();
  }
}

/** Open (creating on first use) the host-side audit-link store. */
export function openAuditStore(path?: string): AuditStoreWriter {
  return new SqliteAuditStore(path ?? process.env.QDS_AUDIT_DB ?? DEFAULT_AUDIT_DB_FILE);
}

/**
 * Steps 1–2 of the no-create opener: `openSync(path, "r")` (never O_CREAT —
 * the probe itself cannot create the store) with the fd HELD, plus the
 * recorded inode. Any probe failure is `audit-store-absent`.
 */
function probeAuditStore(path: string): { ino: number; close(): void } {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    return {
      ino: fstatSync(fd).ino,
      // A close failure on a dying device must not replace the typed refusal
      // the open is about to raise; a double close lands in the same catch.
      close: () => { try { closeSync(fd as number); } catch { /* guarded close */ } },
    };
  } catch (e) {
    try { if (fd !== undefined) closeSync(fd); } catch { /* the refusal below is the diagnosis */ }
    throw new AuditStoreError(
      "audit-store-absent",
      `no readable audit-link store exists at ${path} (${(e as Error).message}) — an uninitialized store is a refusal, never a zero-byte file the read path materialised (INV-AUDIT-6)`,
      `record this run's links first (the write path — openAuditStore() — creates ${path}), or point QDS_AUDIT_DB at an existing store; the walk never creates one`,
    );
  }
}

/**
 * Steps 3–4, bound to the probe: re-open BY PATH (the held fd keeps the
 * probed inode alive but does not pin the path, so comparing the held fd's
 * inode to itself can never fire), compare against the PROBE's recorded
 * inode, close the second fd on every path, and only on verified identity
 * bind the SQLite handle and assert the schema. Never migrates, never creates.
 */
function probeAndBind(path: string, probe: { ino: number }): Database {
  let fd2: number;
  try {
    fd2 = openSync(path, "r");
  } catch (e) {
    throw new AuditStoreError(
      "audit-store-identity-changed",
      `the audit-link store at ${path} was removed between the open probe and the attach (${(e as Error).message}) — the path no longer resolves to the probed inode ${probe.ino}`,
      `re-run the walk against ${path}; if the store was replaced or removed deliberately, treat what is there now as a new chain, never the probed one`,
    );
  }
  let db: Database | undefined;
  try {
    if (fstatSync(fd2).ino !== probe.ino) {
      throw new AuditStoreError(
        "audit-store-identity-changed",
        `the inode at ${path} changed between the open probe and the attach (was ${probe.ino}, now ${fstatSync(fd2).ino}) — the store was replaced mid-open, and the handle would not be the store the walk aimed at`,
        `re-run the walk against ${path}; if replacement is expected, read the replacement, never the pre-open handle`,
      );
    }
    try {
      // No options object: bun:sqlite maps a bare `{}` onto zero open flags
      // ("flags must include SQLITE_OPEN_READONLY or SQLITE_OPEN_READWRITE").
      db = new Database(path);
    } catch (e) {
      throw new AuditStoreError(
        "audit-store-schema-absent",
        `cannot open the audit-link store at ${path} (${(e as Error).message}) — the store does not carry this module's schema`,
        SCHEMA_ABSENT_REMEDIATION,
      );
    }
    const hasTable = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'audit_links'").get();
    if (hasTable === undefined || hasTable === null) {
      throw new AuditStoreError(
        "audit-store-schema-absent",
        `${path} has no audit_links table — the walk never migrates (INV-AUDIT-6: an uninitialized store fails the walk closed)`,
        SCHEMA_ABSENT_REMEDIATION,
      );
    }
    return db;
  } catch (e) {
    try { db?.close(); } catch { /* the original error is the diagnosis */ }
    throw e;
  } finally {
    try { closeSync(fd2); } catch { /* guarded close on every exit path */ }
  }
}

/**
 * The read half the walker uses (story "Digest coverage is asymmetric"):
 * read-write (the walker appends first-observation digest rows) but NEVER
 * creating and NEVER migrating. Refusals, in order: `audit-store-absent` (the
 * no-create probe), `audit-store-identity-changed` (removal or
 * replace-and-restore across the probe→attach window), and
 * `audit-store-schema-absent` (the store exists but carries no `audit_links`
 * table). Every refusal closes every fd it opened — and the half-bound
 * database on the schema arm — before the caller sees it.
 */
export function openAuditStoreForWalk(path: string): AuditStoreReader {
  const started = Date.now();
  const openLine = (status: "ok" | "error", outcome: string, message: string): void =>
    emitLine({ operation: "audit-store.open", requestId: newRequestId(), durationMs: Date.now() - started, status, auditPath: path, outcome, message });
  const probe = probeAuditStore(path);
  let db: Database;
  try {
    db = probeAndBind(path, probe);
  } catch (e) {
    probe.close();
    if (e instanceof AuditStoreError) openLine("error", e.code, e.message);
    throw e;
  }
  probe.close();
  openLine("ok", "opened", `opened ${path} for the walk — no-create probe, inode-verified attach, schema asserted; nothing was created or migrated`);
  return new SqliteAuditReader(db, path);
}

function rowToLink(row: Record<string, unknown>): AuditLinkRow {
  const detailJson = row.detail_json as string | null;
  return {
    linkId: row.link_id as number,
    runId: row.run_id as string, repoSlug: row.repo_slug as string,
    requestId: row.request_id as string, hop: row.hop as AuditHop,
    event: row.event as string, evidenceDigest: row.evidence_digest as string,
    subjectId: (row.subject_id as string | null) ?? undefined,
    subjectKind: (row.subject_kind as string | null) ?? undefined,
    evidencePath: (row.evidence_path as string | null) ?? undefined,
    detail: detailJson === null ? undefined : (JSON.parse(detailJson) as unknown),
    occurredAt: row.occurred_at as string, recordedAt: row.recorded_at as string,
  };
}

class SqliteAuditReader implements AuditStoreReader {
  readonly path: string;
  private readonly db: Database;
  private readonly linksForRunStmt: Statement;
  private readonly existsStmt: Statement;

  constructor(db: Database, path: string) {
    this.db = db;
    this.path = path;
    this.linksForRunStmt = db.prepare("SELECT * FROM audit_links WHERE run_id = ? ORDER BY occurred_at, link_id");
    this.existsStmt = db.prepare("SELECT 1 FROM audit_links WHERE run_id = ? AND hop = ? AND event = ? AND subject_key = ? LIMIT 1");
  }

  linksForRun(runId: string): AuditLinkRow[] {
    return (this.linksForRunStmt.all(runId) as Record<string, unknown>[]).map(rowToLink);
  }

  /**
   * Keyed on the generated `subject_key` column — the same coalesce identity
   * the UNIQUE constraint and `record()`'s ON CONFLICT use, so a presence
   * check and a write can never disagree. bun:sqlite hands back `null` for a
   * no-row .get() on some versions, `undefined` on others — both are absent.
   */
  linkExists(runId: string, hop: string, event: string, subjectId?: string): boolean {
    const hit = this.existsStmt.get(runId, hop, event, subjectId ?? SUBJECT_NONE_KEY);
    return hit !== undefined && hit !== null;
  }

  close(): void {
    this.db.close();
  }
}

/**
 * Test-only split of `openAuditStoreForWalk`'s probe→rebind sequence.
 * `bun:sqlite` opens synchronously, so no real interleaving window exists to
 * race into — the identity refusals are exercised by crossing the window
 * MANUALLY: probe, replace/remove the file, rebind. Both halves are the
 * opener's own internals (called verbatim on the production path), not a
 * parallel copy. Not a public API; neither half writes anything.
 */
export const __auditStoreTestHooks = {
  probeAuditStore,
  probeAndBind,
} as const;
