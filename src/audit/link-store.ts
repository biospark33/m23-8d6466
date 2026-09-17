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
 * The journal stays on DELETE — NEVER WAL — so the store leaves no
 * `-wal`/`-shm` siblings and DF5.4's file-set assertion can be exact. That is
 * ASSERTED, not assumed: `journal_mode` lives in the database header, so a
 * store any other tool opened in WAL stays WAL, and never issuing the pragma
 * is exactly what leaves the claim unchecked. The writer issues
 * `PRAGMA journal_mode = DELETE` once and refuses if the store does not come
 * back on DELETE. Immutability: BEFORE UPDATE/DELETE triggers that
 * RAISE(ROLLBACK) — ABORT would undo only the offending STATEMENT and leave an
 * enclosing transaction free to commit everything else — and no update or
 * delete statement in this module. `evidence_digest` is the sha256
 * of the canonicalised subject, computed by the CALLER at emit time — this
 * store never digests — so a rewritten subject reports `evidence-mismatch`.
 *
 * The read path (`openAuditStoreForWalk`) copies DF2.11's no-create
 * discipline and closes the hole a held-fd-only comparison leaves, because
 * `bun:sqlite`'s `new Database(path)` creates the file when absent: probe →
 * hold the fd → re-open by path → compare inodes → bind. The walk path NEVER
 * migrates and NEVER creates: it asserts the schema and fails closed
 * (`audit-store-schema-absent`, INV-AUDIT-6). It returns ONE handle — reader
 * AND appender (`AuditStoreWalkHandle`) — so the walker's first-observation
 * digest rows go down the inode-verified connection it already proved, never a
 * second by-path open that would re-create and re-migrate a store removed
 * since (which is exactly what `audit-store-identity-changed` exists to catch).
 */

import { chmodSync, closeSync, existsSync, fstatSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";

import { Database, type Statement } from "bun:sqlite";

import { sanitizeLabel } from "../fleet/brief-schema.ts";
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
 * ONLY their vocabulary above. `pr-run`/`run-reverify`/`run-approval` take
 * ONLY `walk-observed`: no emitter exists for them (their lifecycle records
 * are not emitted; their digest rows are the walker's first-observation rows,
 * written by `chain.ts`'s `authorizingDigest`). The remaining four carry NO
 * rows by design — nothing in the tree writes them — and an EMPTY vocabulary
 * is what makes that a refusal rather than a courtesy: manufacturing a link
 * for an event that never occurred is what INV-AUDIT-4 forbids.
 */
const HOP_EVENT_VOCABULARY = {
  "run-credential": ["mint", "deliver", "revoke", "verify-revoked"],
  "run-box": ["create", "fill", "setup-gate", "teardown", "reap"],
  "run-bundle": ["bundle-verify", "bundle-fetch"],
  "pr-run": ["walk-observed"],
  "run-reverify": ["walk-observed"],
  "run-approval": ["walk-observed"],
  "run-issue": [],
  "run-cost": [],
  "run-gate-evidence": [],
  "memory-retain-receipt": [],
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
  /**
   * Presence on the SAME coalesce identity `record()` dedups on. Part of the
   * reader contract DF5.4-C9 imports — `chain.ts` does its presence checks by
   * hand off `linksForRun`, so this has no in-tree production caller today.
   * Do not delete it.
   */
  linkExists(runId: string, hop: string, event: string, subjectId?: string): boolean;
  close(): void;
  readonly path: string;
}

/**
 * What `openAuditStoreForWalk` hands back: the reader PLUS the append of the
 * walker's first-observation digest rows, both over the one inode-verified
 * connection. Structurally an `AuditStoreWriter` too, so a caller holding it as
 * one needs no second open.
 */
export interface AuditStoreWalkHandle extends AuditStoreReader {
  record(link: AuditLinkInput): void;
}

export type AuditStoreErrorCode =
  | "audit-store-absent"
  | "audit-store-unreadable"
  | "audit-store-corrupt"
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
 * key order cannot forge an evidence-mismatch. A top-level or array-element
 * `undefined` canonicalises to `null`, and an `undefined` OBJECT MEMBER IS
 * DROPPED — both exactly as `JSON.stringify` treats them, because
 * `detail_json` is persisted from this function and the walker re-digests what
 * it reads back: a disagreement here is a permanent, uncorrectable false
 * `evidence-mismatch` on an append-only store. Byte-identical by contract to
 * `src/providers/driver.ts`'s `auditCanonicalJson` (there is a drift alarm).
 */
export function canonicalJson(value: unknown): string {
  if (value === undefined || value === null) return "null";
  if (typeof value !== "object") {
    // JSON.stringify returns undefined for a function/symbol — never cast.
    const scalar = JSON.stringify(value);
    return scalar === undefined ? "null" : scalar;
  }
  // `toJSON` FIRST, as JSON.stringify does — and that means BEFORE the array
  // branch, not merely before the object one. A Date is `typeof "object"` and
  // not an array, so `Object.entries` saw no own enumerable keys and the
  // timestamp serialised as `{}` — silent evidence LOSS on an append-only
  // store, not an evidence-mismatch (the digest faithfully attests to the
  // empty object). Same for URL and anything else carrying a toJSON.
  //
  // The ORDER against `Array.isArray` is load-bearing and is the one thing the
  // drift alarm in tests/providers/audit-emit.test.ts must keep pinned: an
  // ARRAY carrying its own `toJSON` takes the toJSON branch under
  // JSON.stringify, so checking `Array.isArray` first would make this copy and
  // `auditCanonicalJson` in src/providers/driver.ts disagree on a value both
  // are contractually required to render identically.
  if (typeof (value as { toJSON?: unknown }).toJSON === "function") return canonicalJson((value as { toJSON(): unknown }).toJSON());
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/** The one digest primitive every emitter composes with `canonicalJson`. */
export function sha256Hex(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

// `IF NOT EXISTS` means a store created before the RAISE(ROLLBACK) change keeps
// its RAISE(ABORT) triggers — still append-only, just statement-scoped. Swapping
// them needs the schema-version gate deferred to DF5.4 (no module code issues
// UPDATE/DELETE, so this is guarantee strength, never an active write path).
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
BEGIN SELECT RAISE(ROLLBACK, 'audit_links is append-only (INV-AUDIT-4)'); END;
CREATE TRIGGER IF NOT EXISTS audit_links_no_delete
BEFORE DELETE ON audit_links
BEGIN SELECT RAISE(ROLLBACK, 'audit_links is append-only (INV-AUDIT-4)'); END;
`;

const INSERT_SQL = `
INSERT INTO audit_links (
  run_id, repo_slug, request_id, hop, event, subject_id, subject_kind,
  evidence_path, evidence_digest, detail_json, occurred_at, recorded_at
) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
ON CONFLICT DO NOTHING`;

/**
 * The stored row on the UNIQUE identity — the generated `subject_key` column,
 * the same coalesce identity the constraint and `ON CONFLICT` use, so a
 * presence check, a divergence check and a write can never disagree.
 */
const STORED_DIGEST_SQL =
  "SELECT evidence_digest FROM audit_links WHERE run_id = ? AND hop = ? AND event = ? AND subject_key = ? LIMIT 1";

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
  // Canonical UTC ISO-8601 or nothing. A stamp the walker's Date.parse cannot
  // read makes its ordering check `continue` — i.e. a garbage timestamp is a
  // way to switch the check OFF — and a non-canonical spelling (`+00:00`, a
  // local offset, epoch millis) sorts wrongly under linksForRun's lexicographic
  // `ORDER BY occurred_at` before the walker ever sees it. Round-tripping
  // through Date is the whole rule; the parse guard is load-bearing because
  // `new Date("nope").toISOString()` throws.
  for (const [field, value] of [
    ["occurredAt", link.occurredAt],
    ["recordedAt", link.recordedAt],
  ] as const) {
    if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
      throw invalidLink(
        `audit link ${field} must be a canonical UTC ISO-8601 stamp (new Date(x).toISOString(), Z-suffixed), got ${JSON.stringify(value)}`,
        `stamp ${field} with new Date().toISOString() at emit time — the walk sorts and orders on these as TEXT`,
      );
    }
  }
  if (link.subjectId === SUBJECT_NONE_KEY) {
    throw invalidLink(
      `subjectId ${JSON.stringify(SUBJECT_NONE_KEY)} is the reserved sentinel the schema's subject_key coalesces a NULL subject to — a literal subject of that name would collide with every subject-less emit on this key`,
      "emit the real subject id, or omit subjectId entirely for a subject-less event",
    );
  }
  // `Object.hasOwn`, never a bare index: the literal inherits from
  // Object.prototype, so `hop: "toString"` would return a FUNCTION, walk past
  // the `=== undefined` guard and make `vocabulary.includes` a raw TypeError —
  // which SqliteAuditReader.record then reports as a store identity change.
  // The hop is wide (`string`) at the provider seam by design, so this is a
  // trust boundary, not a type assertion.
  if (typeof link.hop !== "string" || !Object.hasOwn(HOP_EVENT_VOCABULARY, link.hop)) {
    throw invalidLink(`unknown audit hop ${JSON.stringify(link.hop)}`, VOCAB_REMEDIATION);
  }
  const vocabulary: readonly string[] = HOP_EVENT_VOCABULARY[link.hop as AuditHop];
  if (!vocabulary.includes(link.event)) {
    throw invalidLink(
      vocabulary.length === 0
        ? `hop ${JSON.stringify(link.hop)} carries no rows by design — nothing emits it, so a link for ${JSON.stringify(link.event)} would be manufactured evidence (INV-AUDIT-4)`
        : `event ${JSON.stringify(link.event)} is not in hop ${JSON.stringify(link.hop)}'s vocabulary (${vocabulary.join(" | ")})`,
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
    // The canonicaliser, not bare JSON.stringify: the stored bytes are then the
    // EXACT preimage of evidence_digest, so the walker's
    // digestOf(JSON.parse(detail_json)) round trips for every input. A detail
    // JSON cannot express (a bigint, a cycle) is a typed refusal here rather
    // than a raw TypeError out of the store — this is the trust boundary.
    try {
      detailJson = canonicalJson(link.detail);
    } catch (e) {
      throw invalidLink(
        `detail is not JSON-serialisable (${(e as Error).message}) — a bigint, a cycle, or a toJSON that throws`,
        "send detail as plain JSON values (a bigint must be stringified by the emitter, which is the only place that knows whether precision or magnitude is the point)",
      );
    }
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
  // A throwing log sink must not become the failure of the operation it
  // reports — the same posture src/fleet/dispatch.ts takes around its own log
  // calls. Concretely: the success line in `openAuditStoreForWalk` runs while
  // the Database handle is owned by nobody, so a throw here used to leak it.
  try {
    log({ agentId: null, timestamp: new Date().toISOString(), duration: entry.durationMs, ...entry });
  } catch { /* the operation's own outcome is the result, never the line about it */ }
}

/**
 * Longest a join column may be on a REFUSAL line. Every real one is far under
 * it (a run id, a `owner/repo`, a hop name, an event name), so the cap only
 * ever bites a value that was already invalid — which is the case this exists
 * for.
 */
const REFUSAL_FIELD_MAX = 120;

/**
 * One unvalidated join column, made safe to put in the engine log.
 *
 * The refusal arm of `recordLink` runs AFTER the validator threw, so its inputs
 * have been proven nothing: `runId` may be an object, `hop` a 4 MiB string, any
 * of them may carry control characters that reflow an operator's terminal. The
 * line still needs them — a refusal nobody can grep by run is the gap the line
 * closes — so they are bounded rather than dropped.
 *
 * `sanitizeLabel` is the same treatment `status.ts` gives substrate-supplied
 * box names, and for the same reason: strip, cap, and never let a name surprise
 * a consumer. A non-string is reported as its SHAPE — serialising it is exactly
 * the unbounded echo this guards against.
 */
function refusalField(value: unknown): string {
  if (typeof value === "string") return sanitizeLabel(value, REFUSAL_FIELD_MAX);
  return `<non-string: ${value === null ? "null" : Array.isArray(value) ? "array" : typeof value}>`;
}

/**
 * The one insert path, shared by the writer and the walk handle. `changes === 0`
 * means ON CONFLICT fired on the UNIQUE key — but that alone cannot tell an
 * identical redelivery from a CONTRADICTORY one, and the store is append-only,
 * so the dropped row's disagreement would otherwise leave no trace at all. Read
 * the stored digest back: equal → `duplicate`, `ok`, as before; different →
 * `divergent`, logged at `error` with both digests. Never a throw — a
 * bookkeeping disagreement must not abort a live teardown or harvest.
 */
function recordLink(stmts: { insert: Statement; storedDigest: Statement }, link: AuditLinkInput): void {
  const started = Date.now();
  let detailJson: string | null;
  try {
    ({ detailJson } = validateAndBind(link));
  } catch (e) {
    // Every OTHER outcome of this function emits an `audit-link.record` line —
    // inserted, duplicate, divergent — so a REFUSED emit was the one outcome
    // with no structured trace at all. An operator grepping `audit-link.record`
    // for a run saw the emits that landed and nothing whatsoever for the ones
    // the validator threw out, which reads as "the emitter never fired".
    // The throw still propagates untouched; this only adds the line.
    //
    // FIXED message, never the validator's. `invalidLink` messages quote the
    // REJECTED INPUT back unbounded (`got ${JSON.stringify(value)}`, and the
    // `detail is not JSON-serialisable (${e.message})` arm relays whatever a
    // caller's throwing `toJSON` chose to say) — and this line rides the engine
    // log into the harvest tar, where `detail` is a payload field that carries
    // prompt content BY DESIGN. The refusal's machine-readable half is the
    // `outcome` code; its human half belongs on the throw, which goes to the
    // caller and not into the tar (INV-AUDIT-2).
    const code = (e as { code?: unknown } | null)?.code;
    emitLine({
      operation: "audit-link.record",
      // The link's own correlation when it HAS one — but an empty/non-string
      // `requestId` is itself a validation failure this arm reports, and
      // `emitLine` must not be handed it.
      requestId: typeof link.requestId === "string" && link.requestId.length > 0 ? link.requestId : newRequestId(),
      durationMs: Date.now() - started,
      status: "error",
      // The JOIN COLUMNS stay: INV-AUDIT-2 admits "ids, digests, hops, paths
      // and codes", and a refusal line nobody can grep by run is the very gap
      // this arm exists to close. But they are UNVALIDATED here by definition —
      // the validator threw, so any of them may be a non-string, or a string of
      // any length — so each is bounded the way `status.ts` bounds
      // substrate-supplied names: control characters stripped, length capped.
      // A non-string is reported as its shape, never serialised.
      runId: refusalField(link.runId),
      repoSlug: refusalField(link.repoSlug),
      hop: refusalField(link.hop),
      event: refusalField(link.event),
      subjectKind: link.subjectKind === undefined ? null : refusalField(link.subjectKind),
      outcome: typeof code === "string" ? code : "audit-link-invalid",
      message: "audit link refused",
    });
    throw e;
  }
  const subjectKey = link.subjectId ?? SUBJECT_NONE_KEY;
  const { changes } = stmts.insert.run(
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
  let outcome = "inserted";
  let status: "ok" | "error" = "ok";
  let divergence: Record<string, unknown> = {};
  if (changes !== 1) {
    const stored = stmts.storedDigest.get(link.runId, link.hop, link.event, subjectKey) as { evidence_digest?: string } | null | undefined;
    const storedDigest = stored?.evidence_digest;
    if (typeof storedDigest === "string" && storedDigest !== link.evidenceDigest) {
      outcome = "divergent";
      status = "error";
      divergence = { storedDigest, incomingDigest: link.evidenceDigest, subjectKey };
    } else {
      outcome = "duplicate";
    }
  }
  emitLine({
    operation: "audit-link.record", requestId: link.requestId, durationMs: Date.now() - started, status,
    runId: link.runId, repoSlug: link.repoSlug, hop: link.hop, event: link.event,
    subjectKind: link.subjectKind ?? null, outcome, ...divergence,
    message: outcome === "divergent"
      ? `audit link divergent: run ${link.runId} hop ${link.hop}.${link.event} subject ${subjectKey} was already recorded with a DIFFERENT evidence digest — the stored row stands (append-only, INV-AUDIT-4) and this emit was dropped`
      : `audit link ${outcome}: run ${link.runId} hop ${link.hop}.${link.event}`,
  });
}

/**
 * Write-time init ONLY (the walk path never reaches here): mkdir 0700, create
 * the file 0600, DELETE journal (asserted, see the header), busy_timeout,
 * idempotent schema inside BEGIN IMMEDIATE so two concurrent first-emits cannot
 * race the CREATEs, then the two prepares.
 *
 * EVERY step from the first file touch on lives inside the one try: the handle
 * is closed on every failure path and the throw is always a typed
 * `AuditStoreError` carrying a `remediation` the caller can forward verbatim.
 * Both halves are load-bearing. `MAX_FANOUT_CONCURRENCY` dispatches open this
 * same file in one process on a DELETE-journal whole-file lock, so a leak here
 * is per-arm, not per-process; and an untyped throw is what left dispatch
 * telling an operator to "fix or clear the store path" about a file the walk
 * path (correctly) says must NOT be deleted because it still holds evidence.
 */
function openWriterStore(path: string): { db: Database; insert: Statement; storedDigest: Statement } {
  let db: Database | undefined;
  try {
    // mkdirSync(recursive) returns the FIRST path it created, `undefined` when
    // it created nothing — chmod only what THIS call made. Tightening a
    // directory we did not create is not ours to do: `QDS_AUDIT_DB=/tmp/x.db`
    // would otherwise chmod /tmp to 0700 and break every other user on the host
    // (and a bare `audit.db` would chmod the process CWD). Inside the try
    // because an EACCES here is a store fault like any other and must reach the
    // caller typed, not as a bare fs errno.
    const createdDir = mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    if (createdDir !== undefined) chmodSync(createdDir, 0o700);
    // Create the file OURSELVES at 0600 before SQLite can: sqlite3_open_v2
    // creates at `0666 & ~umask` (0644 under the usual 022) and the chmod lands
    // a statement later — an fd opened by another uid in that window survives
    // the chmod. O_APPEND|O_CREAT is a no-op on an existing store.
    closeSync(openSync(path, "a", 0o600));
    db = new Database(path);
    // Unconditional: a store created once under a permissive umask is otherwise
    // never corrected, and tightening a file that holds audit evidence is the
    // safe direction.
    chmodSync(path, 0o600);
    db.exec("PRAGMA busy_timeout = 5000;");
    // Outside BEGIN IMMEDIATE — journal_mode cannot change inside a
    // transaction. A store another tool left in WAL comes back "wal" here.
    const journal = (db.prepare("PRAGMA journal_mode = DELETE").get() as { journal_mode?: unknown } | null)?.journal_mode;
    if (typeof journal !== "string" || journal.toLowerCase() !== "delete") {
      throw new AuditStoreError(
        "audit-store-unreadable",
        `the audit-link store at ${path} is in journal mode ${JSON.stringify(journal)}, not DELETE — journal_mode is persisted in the database header, so this store was put in that mode by something else and would leave -wal/-shm siblings DF5.4's file-set assertion refuses`,
        `close every other process holding ${path} open (the mode cannot change while one does), then re-run; do NOT delete the store — \`sqlite3 ${path} "PRAGMA journal_mode = DELETE"\` converts it in place`,
      );
    }
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(SCHEMA);
      db.exec("COMMIT");
    } catch (e) {
      try { db.exec("ROLLBACK"); } catch { /* already unwound */ }
      throw e;
    }
    // Drift lands HERE, not at the first write: `CREATE TABLE IF NOT EXISTS`
    // no-ops against an older table, so `STORED_DIGEST_SQL`'s reference to the
    // generated `subject_key` column is what catches a store this module's SQL
    // does not match — as a typed refusal at open (the safety half of the
    // deferred schema-version gate), never a raw SQLiteError at emit time.
    return { db, insert: db.prepare(INSERT_SQL), storedDigest: db.prepare(STORED_DIGEST_SQL) };
  } catch (e) {
    try { db?.close(); } catch { /* the handle dies with the process */ }
    throw classifyStoreFault(path, e, () =>
      new AuditStoreError(
        "audit-store-unreadable",
        `the audit-link store at ${path} could not be opened for writing (${(e as Error).message})`,
        `check that ${dirname(path)} exists and is writable by this uid and that QDS_AUDIT_DB points where you intend; do NOT delete an existing store — it holds this run's evidence`,
      ),
    );
  }
}

class SqliteAuditStore implements AuditStoreWriter {
  readonly path: string;
  private readonly db: Database;
  private readonly insert: Statement;
  private readonly storedDigest: Statement;

  constructor(path: string) {
    this.path = path;
    const bound = openWriterStore(path);
    this.db = bound.db;
    this.insert = bound.insert;
    this.storedDigest = bound.storedDigest;
  }

  record(link: AuditLinkInput): void {
    try {
      recordLink({ insert: this.insert, storedDigest: this.storedDigest }, link);
    } catch (e) {
      // `audit-link-invalid` (and every other typed refusal) passes through
      // untouched — that one is the caller's own bad link. A driver fault on
      // the insert (SQLITE_BUSY from a concurrent arm, ENOSPC, drift) is what
      // must not reach a caller as a raw SQLiteError with no remediation.
      throw classifyStoreFault(this.path, e, () => e as Error);
    }
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
/**
 * The underlying fault, as a string: `ENOENT`/`EACCES` from node:fs,
 * `SQLITE_NOTADB`/`SQLITE_CORRUPT`/`SQLITE_CANTOPEN` from bun:sqlite. The
 * message is folded in because bun has carried the SQLite code in the message
 * rather than on `.code` across versions — but BOTH node:fs and bun:sqlite
 * interpolate the filename into that message, and the filename is
 * operator-controlled (`QDS_AUDIT_DB`). Matching it unstripped made
 * `QDS_AUDIT_DB=/tmp/EACCES-repro/audit.db` classify a plain ENOENT as a
 * permission refusal, so the path comes out before any needle goes in.
 */
function faultOf(e: unknown, path: string): string {
  const code = (e as { code?: unknown } | null)?.code;
  const message = (e as { message?: unknown } | null)?.message;
  const text = typeof message === "string" ? message.replaceAll(path, "<path>") : "";
  return `${typeof code === "string" ? code : ""} ${text}`;
}

function anyOf(fault: string, ...needles: string[]): boolean {
  return needles.some((n) => fault.includes(n));
}

const DRIFT_REMEDIATION =
  "do NOT delete the store — it holds evidence; archive it aside and let a fresh store be created, or point QDS_AUDIT_DB at one this version wrote";

/**
 * The one fault taxonomy, shared by the writer open, the walk attach and the
 * walk-handle append: a store fault means the same thing whichever path found
 * it, and an operator must never get two contradictory remediations for one
 * file (the dispatch path said "fix or clear the store path" about the very
 * file the walk path says must not be deleted). `fallback` supplies the code
 * for the faults only the CALLER can name — schema-absent for the walk's
 * missing table, identity-changed for a handle whose inode went away.
 */
function classifyStoreFault(path: string, e: unknown, fallback: () => Error): Error {
  if (e instanceof AuditStoreError) return e;
  const message = (e as Error)?.message;
  const fault = faultOf(e, path);
  if (anyOf(fault, "SQLITE_NOTADB", "SQLITE_CORRUPT", "not a database", "file is encrypted")) {
    return new AuditStoreError(
      "audit-store-corrupt",
      `the audit-link store at ${path} is not a readable SQLite database (${message}) — it is corrupt, truncated, or not a store at all`,
      `do NOT delete or overwrite ${path} — it may still hold recoverable evidence; copy it aside, then try \`sqlite3 ${path} ".recover"\` and walk the recovered copy via QDS_AUDIT_DB`,
    );
  }
  // Transient by construction, and the one fault that must never read as
  // tampering: the journal is DELETE, so every writer takes a whole-file lock
  // and a fan-out arm can genuinely wait out the 5 s busy_timeout.
  if (anyOf(fault, "SQLITE_BUSY", "SQLITE_LOCKED", "database is locked", "database table is locked")) {
    return new AuditStoreError(
      "audit-store-unreadable",
      `the audit-link store at ${path} was locked by another writer for longer than the 5 s busy_timeout (${message}) — this is contention, NOT a damaged or replaced store`,
      `re-run once the other emitter finishes (\`lsof ${path}\` names it); the store and every row already in it are intact`,
    );
  }
  if (anyOf(fault, "SQLITE_CANTOPEN", "SQLITE_READONLY", "SQLITE_FULL", "SQLITE_IOERR", "EACCES", "EPERM", "EROFS", "ENOSPC", "EIO", "disk I/O error", "disk is full")) {
    return new AuditStoreError(
      "audit-store-unreadable",
      `cannot use the audit-link store at ${path} (${message}) — the file is there but the filesystem or its permissions refused it`,
      `check the uid, the mount (read-only or full filesystems fail here too) and the free space on ${path}'s device, then re-run; the store itself is untouched`,
    );
  }
  // Column drift: `CREATE TABLE IF NOT EXISTS` no-ops against an older table,
  // so a shape mismatch surfaces on prepare/run, not on the open.
  if (anyOf(fault, "no such column", "has no column", "no such table")) {
    return new AuditStoreError(
      "audit-store-schema-absent",
      `the audit_links table at ${path} does not match this module's schema (${message}) — the store was written by a different version of this module or by another tool`,
      DRIFT_REMEDIATION,
    );
  }
  return fallback();
}

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
    // A store this process cannot READ is not an ABSENT store: telling an
    // operator to "record this run's links first" when the evidence is sitting
    // right there, mode 0600 under another uid, is advice that costs them the
    // chain.
    if (anyOf(faultOf(e, path), "EACCES", "EPERM")) {
      throw new AuditStoreError(
        "audit-store-unreadable",
        `the audit-link store at ${path} exists but this process cannot read it (${(e as Error).message}) — the evidence is there; the permission is not`,
        `run the walk as the uid that owns ${path} (the store is created 0600 by its emitter), or copy the store somewhere readable and point QDS_AUDIT_DB at the copy; never chmod the original to widen it`,
      );
    }
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
    let hasTable: unknown;
    try {
      // `{ readwrite: true }` — READWRITE without CREATE, the ONLY flag pair
      // that keeps INV-AUDIT-6 true here. The inode check above closes the
      // probe→attach window for a REPLACED store, but this open resolves the
      // PATH a third time: with bun's default flags (which include
      // SQLITE_OPEN_CREATE) a store unlinked in the residual window would be
      // MATERIALISED as a fresh empty database by the very function that swears
      // it never creates one — and the next openAuditStore() would adopt that
      // empty file as a legitimately-empty chain. A bare `{}` is what maps onto
      // zero open flags ("flags must include SQLITE_OPEN_READONLY or
      // SQLITE_OPEN_READWRITE"); a non-empty object does not.
      db = new Database(path, { readwrite: true });
      // `new Database` is LAZY — it does not touch the file, so a corrupt store
      // surfaces on the first statement that READS the header, not on the open.
      // Both file-touching statements therefore live inside THIS catch, or
      // `audit-store-corrupt` is unreachable and the operator gets a raw
      // SQLiteError that no caller can narrow on.
      // The walker APPENDS its first-observation digest rows over this handle;
      // without a busy_timeout a concurrent emitter turns linksForRun into an
      // immediate SQLITE_BUSY that the walker reports as a BROKEN chain — a
      // transient lock misread as tampering.
      db.exec("PRAGMA busy_timeout = 5000;");
      hasTable = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'audit_links'").get();
    } catch (e) {
      // A failed open is not automatically a SCHEMA failure. Corruption and a
      // permission/quota fault each get their own code, because
      // "point QDS_AUDIT_DB at a store created by openAuditStore" told to an
      // operator whose store is merely truncated invites them to abandon the
      // file that still holds the evidence.
      //
      // The no-CREATE open turns "unlinked in the residual window" into a
      // refusal instead of a materialised empty store — but SQLITE_CANTOPEN
      // then reads as a permission fault, so name the real cause first.
      if (!existsSync(path)) {
        throw new AuditStoreError(
          "audit-store-identity-changed",
          `the audit-link store at ${path} was unlinked between the inode check and the attach (${(e as Error).message}) — the attach was REFUSED rather than allowed to create a replacement (INV-AUDIT-6), so nothing was written at the path`,
          `re-run the walk against ${path}; if the store was removed deliberately, treat what is there now as a new chain, never the probed one`,
        );
      }
      throw classifyStoreFault(path, e, () =>
        new AuditStoreError(
          "audit-store-schema-absent",
          `cannot open the audit-link store at ${path} (${(e as Error).message}) — the store does not carry this module's schema`,
          SCHEMA_ABSENT_REMEDIATION,
        ),
      );
    }
    // A readable store with no audit_links table returns a ROW-LESS .get() —
    // it never throws — so this stays a schema refusal, not a corruption one.
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
 * creating and NEVER migrating — the returned handle appends over the one
 * connection this function verified. Refusals, in order: `audit-store-absent`
 * (the no-create probe found nothing), `audit-store-unreadable` (it is there
 * and the permission/filesystem is not), `audit-store-identity-changed`
 * (removal or replace-and-restore across the probe→attach window),
 * `audit-store-corrupt` (it is not a readable SQLite database), and
 * `audit-store-schema-absent` (it opens but carries no `audit_links` table).
 * Every refusal closes every fd it opened — and the half-bound database on the
 * schema arm — before the caller sees it.
 */
export function openAuditStoreForWalk(path: string): AuditStoreWalkHandle {
  const started = Date.now();
  const openLine = (status: "ok" | "error", outcome: string, message: string): void =>
    emitLine({ operation: "audit-store.open", requestId: newRequestId(), durationMs: Date.now() - started, status, auditPath: path, outcome, message });
  // The PROBE's own failure gets the same `audit-store.open` error line as
  // every failure past it. `audit-store-absent` is the single most common way
  // this opener refuses (no store, wrong `QDS_AUDIT_DB`, unreadable file) and
  // it was the ONE refusal that emitted no open line — so the walk's structured
  // log jumped straight from "walk started" to hops 4/5/6 reporting broken with
  // no record of the store ever having been reached for.
  let probe: { ino: number; close(): void };
  try {
    probe = probeAuditStore(path);
  } catch (e) {
    if (e instanceof AuditStoreError) openLine("error", e.code, e.message);
    throw e;
  }
  let db: Database;
  try {
    db = probeAndBind(path, probe);
  } catch (e) {
    probe.close();
    if (e instanceof AuditStoreError) openLine("error", e.code, e.message);
    throw e;
  }
  probe.close();
  // The handle FIRST, the ok line second. The reader's constructor prepares
  // `STORED_DIGEST_SQL`, which names the generated `subject_key` column — on a
  // drifted store that threw a raw SQLiteError AFTER this line had already
  // logged success, with `db` owned by nobody. Three claims in this doc block
  // were false on that path; the guard is what makes them true.
  let handle: AuditStoreWalkHandle;
  try {
    handle = new SqliteAuditReader(db, path);
  } catch (e) {
    try { db.close(); } catch { /* the original error is the diagnosis */ }
    const typed = classifyStoreFault(path, e, () =>
      new AuditStoreError(
        "audit-store-schema-absent",
        `cannot bind the audit-link store at ${path} for the walk (${(e as Error).message}) — the store carries an audit_links table this module's SQL does not match`,
        DRIFT_REMEDIATION,
      ),
    );
    if (typed instanceof AuditStoreError) openLine("error", typed.code, typed.message);
    throw typed;
  }
  openLine("ok", "opened", `opened ${path} for the walk — no-create probe, inode-verified attach, schema asserted; nothing was created or migrated`);
  return handle;
}

/**
 * Column → field, over rows this module did not necessarily write: the walk
 * opener accepts any `QDS_AUDIT_DB`, and the immutability triggers block
 * UPDATE/DELETE, not INSERT. `detail_json` is therefore parsed behind a guard
 * and `hop` narrowed against `AUDIT_HOPS` — one malformed row used to throw a
 * raw SyntaxError out of `linksForRun`, which chain.ts flattens into "unhandled
 * walk error" for the whole hop; on an append-only store that row can never be
 * removed, so the chain stayed broken with no remediation and no code.
 */
function rowToLink(path: string, row: Record<string, unknown>): AuditLinkRow {
  const linkId = row.link_id as number;
  const detailJson = row.detail_json;
  let detail: unknown;
  if (detailJson !== null && detailJson !== undefined) {
    if (typeof detailJson !== "string") {
      throw corruptRow(path, linkId, `detail_json is ${typeof detailJson}, not TEXT (SQLite columns carry affinity, not type enforcement)`);
    }
    try {
      detail = JSON.parse(detailJson);
    } catch (e) {
      throw corruptRow(path, linkId, `detail_json is not valid JSON (${(e as Error).message})`);
    }
  }
  const hop = row.hop;
  if (typeof hop !== "string" || !(AUDIT_HOPS as readonly string[]).includes(hop)) {
    throw corruptRow(path, linkId, `hop ${JSON.stringify(hop)} is not one of this module's hops (${AUDIT_HOPS.join(" | ")})`);
  }
  return {
    linkId,
    runId: row.run_id as string, repoSlug: row.repo_slug as string,
    requestId: row.request_id as string, hop: hop as AuditHop,
    event: row.event as string, evidenceDigest: row.evidence_digest as string,
    subjectId: (row.subject_id as string | null) ?? undefined,
    subjectKind: (row.subject_kind as string | null) ?? undefined,
    evidencePath: (row.evidence_path as string | null) ?? undefined,
    detail,
    occurredAt: row.occurred_at as string, recordedAt: row.recorded_at as string,
  };
}

function corruptRow(path: string, linkId: unknown, what: string): AuditStoreError {
  return new AuditStoreError(
    "audit-store-corrupt",
    `audit_links row link_id ${String(linkId)} in ${path} is unreadable: ${what}`,
    `inspect that row (\`sqlite3 ${path} "SELECT * FROM audit_links WHERE link_id = ${String(linkId)}"\`); do NOT delete or overwrite ${path} — the rest of the chain is still there and the store is append-only, so copy it aside and \`.recover\` the copy if the row is damaged`,
  );
}

class SqliteAuditReader implements AuditStoreWalkHandle {
  readonly path: string;
  private readonly db: Database;
  private readonly linksForRunStmt: Statement;
  private readonly storedDigestStmt: Statement;
  /**
   * Prepared on first append only: the walk asserted that `audit_links` EXISTS,
   * not that its columns match this module's INSERT, and a store whose write
   * shape drifted must still be READABLE.
   */
  private insertStmt: Statement | undefined;

  constructor(db: Database, path: string) {
    this.db = db;
    this.path = path;
    this.linksForRunStmt = db.prepare("SELECT * FROM audit_links WHERE run_id = ? ORDER BY occurred_at, link_id");
    this.storedDigestStmt = db.prepare(STORED_DIGEST_SQL);
  }

  linksForRun(runId: string): AuditLinkRow[] {
    return (this.linksForRunStmt.all(runId) as Record<string, unknown>[]).map((row) => rowToLink(this.path, row));
  }

  /**
   * Keyed on the generated `subject_key` column — the same coalesce identity
   * the UNIQUE constraint and `record()`'s ON CONFLICT use, so a presence
   * check and a write can never disagree. bun:sqlite hands back `null` for a
   * no-row .get() on some versions, `undefined` on others — both are absent.
   */
  linkExists(runId: string, hop: string, event: string, subjectId?: string): boolean {
    // The same refusal `validateAndBind` gives the write side. Without it the
    // two sides disagree on exactly one input: `subjectId: "<none>"` coalesces
    // onto the key of every subject-LESS row, so this reports a link for a
    // subject that has none — and no row with that literal subject can exist,
    // because the write side refuses it.
    if (subjectId === SUBJECT_NONE_KEY) {
      throw invalidLink(
        `linkExists was asked for subjectId ${JSON.stringify(SUBJECT_NONE_KEY)} — the reserved sentinel the schema's subject_key coalesces a NULL subject to, so the query would match every subject-less row for ${runId} ${hop}.${event}`,
        "ask for the real subject id, or omit subjectId entirely to check the subject-less row",
      );
    }
    const hit = this.storedDigestStmt.get(runId, hop, event, subjectId ?? SUBJECT_NONE_KEY);
    return hit !== undefined && hit !== null;
  }

  /**
   * The walker's first-observation digest rows, appended over the SAME
   * inode-verified handle the read path bound — no second by-path open, so a
   * store removed or replaced since cannot be silently re-created and
   * re-migrated underneath the walk.
   */
  record(link: AuditLinkInput): void {
    try {
      this.insertStmt ??= this.db.prepare(INSERT_SQL);
      recordLink({ insert: this.insertStmt, storedDigest: this.storedDigestStmt }, link);
    } catch (e) {
      // A typed refusal from validateAndBind is the caller's own bad link.
      if (e instanceof AuditStoreError) throw e;
      // `identity-changed` is reserved for the signature it NAMES: SQLite
      // refuses writes on an unlinked inode with "attempt to write a readonly
      // database". Everything else — a concurrent emitter's SQLITE_BUSY, a full
      // disk, the column drift the lazy prepare above deliberately anticipates —
      // is a different fault with a different remediation, and mapping them all
      // here told an operator their evidence had been replaced and invited them
      // to discard an intact chain.
      const gone = new AuditStoreError(
        "audit-store-identity-changed",
        `cannot append the walk's first-observation link to ${this.path} (${(e as Error).message}) — the store this walk verified is gone or no longer writable, and nothing was re-created at the path`,
        `re-run the walk against ${this.path}; if the store was removed or replaced deliberately, treat what is there now as a new chain, never the one this walk began on`,
      );
      // The unlinked-inode signature is checked on the FILESYSTEM, not in the
      // driver message: SQLite reports the same removal as "attempt to write a
      // readonly database" or as a bare "disk I/O error" depending on what its
      // page cache had already touched, and the second spelling is
      // indistinguishable from a genuine device fault by message alone.
      if (!existsSync(this.path) || anyOf(faultOf(e, this.path), "SQLITE_READONLY", "readonly database")) throw gone;
      throw classifyStoreFault(this.path, e, () => gone);
    }
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
