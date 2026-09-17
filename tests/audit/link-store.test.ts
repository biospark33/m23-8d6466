/**
 * DF5.3 audit-link store TDD.
 *
 * Clause map (story Tests + DoD "the walker never creates the store it
 * audits"):
 * - redelivery idempotence on the COALESCE sentinel (NULLs-distinct trap), and
 *   that ON CONFLICT is a NO-OP rather than an upsert: a DIVERGENT re-emit
 *   leaves the first row untouched and is logged `divergent`/`error`
 * - immutability: UPDATE/DELETE abort via trigger, row unchanged (INV-AUDIT-4)
 * - emit-time digest: the store digests nothing; canonicalJson/sha256Hex, and
 *   the RELATION between them — `detail_json` is the exact digest preimage
 * - rowToLink's column→field mapping, including the null → undefined coercion
 * - audit-store-absent / -unreadable / -corrupt: typed refusals with a
 *   remediation that names the action AND the path
 * - identity window: replace-and-restore and removal across the probe→bind
 *   window refuse `audit-store-identity-changed`, write nothing, byte-identical
 * - schema-absent: zero-byte and foreign-schema stores refuse fail-closed
 * - write-time init: a dir the store CREATED is 0700, a pre-existing one keeps
 *   its mode, the file is 0600 even when pre-existing, DELETE journal, no
 *   -wal/-shm siblings WHILE A HANDLE IS OPEN; explicit path beats QDS_AUDIT_DB
 * - two concurrent first-emits both land (BEGIN IMMEDIATE + busy_timeout)
 * - write-time refusals, each pinned to the RULE that fired: vocabulary (incl.
 *   the hops that carry no rows by design), the `<none>` sentinel, canonical
 *   UTC ISO stamps, digest shape, the 8 KiB cap measured in BYTES
 * - linksForRun ordering: occurred_at then link_id
 * - the walk handle APPENDS over the one inode-verified connection
 *
 * Every test chdirs into its own tmpdir FIRST so the default store path can
 * never resolve at the repo root — the real `.sandbox/` is never touched.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  DEFAULT_AUDIT_DB_FILE,
  __auditStoreTestHooks,
  canonicalJson,
  openAuditStore,
  openAuditStoreForWalk,
  sha256Hex,
  type AuditLinkInput,
  type AuditLinkRow,
  AuditStoreError,
} from "../../src/audit/link-store.ts";
import { type LogEntry, setLogSink } from "../../src/swarmclaw/log.ts";

let dir: string;
let prevCwd: string;
let prevAuditEnv: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qds-df53-links-"));
  prevCwd = process.cwd();
  prevAuditEnv = process.env.QDS_AUDIT_DB;
  // biome-ignore lint/performance/noDelete: unsetting env vars requires delete
  delete process.env.QDS_AUDIT_DB;
  process.chdir(dir);
});

afterEach(() => {
  // biome-ignore lint/performance/noDelete: unsetting env vars requires delete
  if (prevAuditEnv === undefined) delete process.env.QDS_AUDIT_DB;
  else process.env.QDS_AUDIT_DB = prevAuditEnv;
  process.chdir(prevCwd);
  rmSync(dir, { recursive: true, force: true });
});

/** A legal run-credential mint link; every test overrides what it exercises. */
function validLink(over: Partial<AuditLinkInput> = {}): AuditLinkInput {
  return {
    runId: "run-1",
    repoSlug: "acme/widgets",
    requestId: "req-1",
    hop: "run-credential",
    event: "mint",
    subjectId: "key-1",
    subjectKind: "run-key",
    evidencePath: "/sandbox/runs/run-1.json",
    evidenceDigest: sha256Hex("subject"),
    detail: { limitMicroUsd: 5_000_000 },
    occurredAt: "2026-09-16T00:00:00.000Z",
    recordedAt: "2026-09-16T00:00:00.001Z",
    ...over,
  };
}

function rowCount(path: string): number {
  const db = new Database(path);
  try {
    return (db.prepare("SELECT COUNT(*) AS n FROM audit_links").get() as { n: number }).n;
  } finally {
    db.close();
  }
}

/** Every stored column of one row, by name — the shape rowToLink maps from. */
function readRow(path: string, linkId = 1): Record<string, unknown> {
  const db = new Database(path);
  try {
    return db
      .prepare(
        "SELECT link_id, run_id, repo_slug, request_id, hop, event, subject_id, subject_kind, evidence_path, evidence_digest, detail_json, occurred_at, recorded_at, subject_key FROM audit_links WHERE link_id = ?",
      )
      .get(linkId) as Record<string, unknown>;
  } finally {
    db.close();
  }
}

function fileHash(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** The module's structured lines for the duration of `fn` (log.ts's own seam). */
function capturedLines(fn: () => void): LogEntry[] {
  const lines: LogEntry[] = [];
  const restore = setLogSink((entry) => lines.push(entry));
  try {
    fn();
  } finally {
    restore();
  }
  return lines;
}

/** The one typed refusal a thunk raises, narrowed. */
function refusalOf(fn: () => unknown): AuditStoreError {
  try {
    fn();
  } catch (e) {
    if (e instanceof AuditStoreError) return e;
    throw e;
  }
  throw new Error("expected an AuditStoreError, nothing was thrown");
}

describe("redelivery idempotence", () => {
  test("an identical (run_id, hop, event, subject_id) redelivery leaves ONE row", () => {
    const p = join(dir, "audit.db");
    const store = openAuditStore(p);
    store.record(validLink());
    const lines = capturedLines(() => store.record(validLink()));
    store.close();
    expect(rowCount(p)).toBe(1);
    expect(lines.map((l) => [l.outcome, l.status])).toEqual([["duplicate", "ok"]]);
  });

  test("a DIVERGENT redelivery is a NO-OP, never an upsert, and is logged divergent/error", () => {
    const p = join(dir, "audit.db");
    const store = openAuditStore(p);
    const first = validLink();
    store.record(first);
    // Same UNIQUE identity, EVERY other field different. `rowCount === 1` alone
    // cannot tell DO NOTHING from DO UPDATE — an upsert leaves one row too — so
    // the first emit's values are what has to be read back.
    const second = validLink({
      repoSlug: "evil/fork",
      requestId: "req-2",
      subjectKind: "tampered",
      evidencePath: "/sandbox/runs/other.json",
      evidenceDigest: sha256Hex("a different subject entirely"),
      detail: { limitMicroUsd: 9_999_999 },
      occurredAt: "2026-09-16T01:00:00.000Z",
      recordedAt: "2026-09-16T01:00:00.001Z",
    });
    // A bookkeeping disagreement must not abort a live teardown or harvest.
    const lines = capturedLines(() => {
      expect(() => store.record(second)).not.toThrow();
    });
    store.close();

    expect(rowCount(p)).toBe(1);
    expect(readRow(p)).toEqual({
      link_id: 1,
      run_id: "run-1",
      repo_slug: "acme/widgets",
      request_id: "req-1",
      hop: "run-credential",
      event: "mint",
      subject_id: "key-1",
      subject_kind: "run-key",
      evidence_path: "/sandbox/runs/run-1.json",
      evidence_digest: first.evidenceDigest,
      detail_json: canonicalJson(first.detail),
      occurred_at: "2026-09-16T00:00:00.000Z",
      recorded_at: "2026-09-16T00:00:00.001Z",
      subject_key: "key-1",
    });

    const divergent = lines.find((l) => l.outcome === "divergent");
    expect(divergent?.status).toBe("error");
    expect(divergent?.storedDigest).toBe(first.evidenceDigest);
    expect(divergent?.incomingDigest).toBe(second.evidenceDigest);
    expect(divergent?.subjectKey).toBe("key-1");
    expect(String(divergent?.message)).toMatch(/DIFFERENT evidence digest/);
  });

  test("distinct subject_ids coexist on the same key", () => {
    const p = join(dir, "audit.db");
    const store = openAuditStore(p);
    store.record(validLink({ subjectId: "key-1" }));
    store.record(validLink({ subjectId: "key-2" }));
    store.close();
    expect(rowCount(p)).toBe(2);
  });

  test("two subject-LESS emits for the same key coalesce to ONE row (the COALESCE sentinel)", () => {
    const p = join(dir, "audit.db");
    const store = openAuditStore(p);
    // A bare subject_id UNIQUE would let both of these through: NULLs are
    // distinct in a SQLite UNIQUE index. The generated column is the fix.
    store.record(validLink({ subjectId: undefined }));
    store.record(validLink({ subjectId: undefined }));
    store.close();
    expect(rowCount(p)).toBe(1);
  });

  test("linkExists keys on the same coalesce identity record() dedups on", () => {
    const p = join(dir, "audit.db");
    const store = openAuditStore(p);
    store.record(validLink({ subjectId: undefined }));
    store.record(validLink({ subjectId: "key-1", event: "deliver" }));
    store.close();
    const reader = openAuditStoreForWalk(p);
    expect(reader.linkExists("run-1", "run-credential", "mint")).toBeTrue(); // sentinel row
    expect(reader.linkExists("run-1", "run-credential", "mint", "key-1")).toBeFalse(); // sentinel ≠ a subject
    expect(reader.linkExists("run-1", "run-credential", "deliver", "key-1")).toBeTrue();
    expect(reader.linkExists("run-1", "run-credential", "revoke")).toBeFalse();
    expect(reader.linkExists("run-9", "run-credential", "mint")).toBeFalse();
    // The sentinel IS the key on the read side, by design — the write-side
    // refusal below is what keeps a real subject from ever reaching it.
    expect(reader.linkExists("run-1", "run-credential", "mint", "<none>")).toBeTrue();
    reader.close();
  });
});

describe("immutability (INV-AUDIT-4)", () => {
  test("UPDATE aborts and the row is unchanged", () => {
    const p = join(dir, "audit.db");
    const store = openAuditStore(p);
    store.record(validLink());
    store.close();
    const db = new Database(p);
    try {
      expect(() => db.exec("UPDATE audit_links SET event = 'tampered', evidence_digest = 'x'")).toThrow(/append-only/);
      const row = db.prepare("SELECT event, evidence_digest FROM audit_links").get() as {
        event: string;
        evidence_digest: string;
      };
      expect(row.event).toBe("mint");
      expect(row.evidence_digest).toBe(sha256Hex("subject"));
      expect((db.prepare("SELECT COUNT(*) AS n FROM audit_links").get() as { n: number }).n).toBe(1);
    } finally {
      db.close();
    }
  });

  test("DELETE aborts and THE row survives", () => {
    const p = join(dir, "audit.db");
    const store = openAuditStore(p);
    store.record(validLink());
    store.close();
    const db = new Database(p);
    try {
      expect(() => db.exec("DELETE FROM audit_links")).toThrow(/append-only/);
      expect((db.prepare("SELECT COUNT(*) AS n FROM audit_links").get() as { n: number }).n).toBe(1);
      // A count proves a row exists, not that it is the one that was recorded.
      const row = db.prepare("SELECT link_id, event, evidence_digest FROM audit_links").get() as {
        link_id: number;
        event: string;
        evidence_digest: string;
      };
      expect(row).toEqual({ link_id: 1, event: "mint", evidence_digest: sha256Hex("subject") });
    } finally {
      db.close();
    }
  });
});

describe("emit-time digest and canonicalisation", () => {
  test("the store records the caller's digest verbatim — it never digests", () => {
    const p = join(dir, "audit.db");
    const store = openAuditStore(p);
    const callersDigest = sha256Hex("anything the caller chose");
    store.record(validLink({ evidenceDigest: callersDigest, detail: { b: 1, a: 2 } }));
    store.close();
    const db = new Database(p);
    try {
      const row = db.prepare("SELECT evidence_digest, detail_json FROM audit_links").get() as {
        evidence_digest: string;
        detail_json: string;
      };
      // Not sha256Hex(canonicalJson(detail)) — the store would then be free
      // to drift from the emitter's own notion of the subject.
      expect(row.evidence_digest).toBe(callersDigest);
      expect(JSON.parse(row.detail_json)).toEqual({ b: 1, a: 2 });
    } finally {
      db.close();
    }
  });

  test("canonicalJson sorts keys recursively, keeps array order and unicode", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
    expect(canonicalJson({ z: [3, 1, 2] })).toBe('{"z":[3,1,2]}');
    expect(canonicalJson({ "é": 1, a: 2 })).toBe('{"a":2,"é":1}');
    // Key order cannot forge a digest difference.
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
  });

  test("canonicalJson agrees with JSON.stringify on undefined: members dropped, ELEMENTS null", () => {
    // `detail_json` is persisted from this function and the walker re-digests
    // what it reads back, so a disagreement with JSON.stringify is a permanent
    // false `evidence-mismatch` on an append-only store.
    expect(canonicalJson({ n: null, u: undefined })).toBe('{"n":null}');
    // Array elements are NOT dropped — dropping one would renumber the rest.
    expect(canonicalJson([1, undefined, 2])).toBe("[1,null,2]");
    const flat = { a: 1, n: null, s: "x", u: undefined };
    expect(canonicalJson(flat)).toBe(JSON.stringify(flat));
    // A function/symbol/undefined has no JSON form — "null", never a cast.
    expect(canonicalJson(undefined)).toBe("null");
    expect(canonicalJson(() => 1)).toBe("null");
  });

  test("sha256Hex matches the known vector", () => {
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  test("detail_json is the EXACT preimage of the digest the caller recorded", () => {
    const p = join(dir, "audit.db");
    const store = openAuditStore(p);
    // The two halves of the round-trip bug: an `undefined` member (which
    // JSON.stringify drops) and a Date member (a toJSON carrier).
    const detail = { tip: undefined, at: new Date("2026-09-16T00:00:00.000Z"), n: 1 };
    const digest = sha256Hex(canonicalJson(detail));
    store.record(validLink({ detail, evidenceDigest: digest }));
    store.close();
    const row = readRow(p);
    // The relation the walker's mismatch check depends on: what is on disk
    // re-digests to what was recorded.
    expect(sha256Hex(canonicalJson(JSON.parse(row.detail_json as string)))).toBe(digest);
    expect(row.detail_json).toBe(canonicalJson(detail));
    // toJSON is honoured before the object branch, so a Date survives as the ISO
    // stamp the emitter meant to record — not as an empty object with a valid digest.
    expect(row.detail_json).toBe('{"at":"2026-09-16T00:00:00.000Z","n":1}');
  });
});

describe("rowToLink column → field mapping", () => {
  test("linksForRun hands back every input field under its own name, plus linkId", () => {
    const p = join(dir, "audit.db");
    const store = openAuditStore(p);
    const full = validLink();
    // Every nullable column omitted — the null → undefined coercion.
    const sparse = validLink({
      event: "deliver",
      subjectId: undefined,
      subjectKind: undefined,
      evidencePath: undefined,
      detail: undefined,
      occurredAt: "2026-09-16T00:00:02.000Z",
    });
    store.record(full);
    store.record(sparse);
    store.close();

    const reader = openAuditStoreForWalk(p);
    const [a, b] = reader.linksForRun("run-1");
    // A transposition (runId: row.request_id, subjectKind ↔ evidencePath) ships
    // green against a toHaveLength assertion; the walker consumes these names.
    // `hop` is the one field the row narrows (AuditLinkInput stays wide at the
    // provider seam), so the expected literal is asserted, not the received row.
    expect(a).toEqual({ ...full, linkId: 1 } as AuditLinkRow);
    expect(b).toEqual({ ...sparse, linkId: 2 } as AuditLinkRow);
    // toEqual treats an absent key and an undefined one alike — `null` does not
    // satisfy toBeUndefined, so this is what pins the coercion.
    expect(b?.subjectId).toBeUndefined();
    expect(b?.subjectKind).toBeUndefined();
    expect(b?.evidencePath).toBeUndefined();
    expect(b?.detail).toBeUndefined();
    reader.close();
  });
});

describe("no-create walk opener", () => {
  test("audit-store-absent: typed refusal and the path STILL does not exist", () => {
    const p = join(dir, "never-created.db");
    expect(() => openAuditStoreForWalk(p)).toThrow(AuditStoreError);
    const e = refusalOf(() => openAuditStoreForWalk(p));
    expect(e.code).toBe("audit-store-absent");
    // A remediation that exists is not a remediation: it has to name the next
    // action AND the path that failed.
    expect(e.remediation).toContain(p);
    expect(e.remediation).toMatch(/openAuditStore\(\)/);
    expect(e.remediation).toMatch(/the walk never creates one/);
    // Checked on the filesystem, not in a log.
    expect(existsSync(p)).toBeFalse();
  });

  test.skipIf(process.getuid?.() === 0)(
    "audit-store-unreadable: the evidence is there and the permission is not",
    () => {
      const p = join(dir, "audit.db");
      const store = openAuditStore(p);
      store.record(validLink());
      store.close();
      chmodSync(p, 0o000);
      try {
        const e = refusalOf(() => openAuditStoreForWalk(p));
        expect(e.code).toBe("audit-store-unreadable");
        expect(e.remediation).toContain(p);
        expect(e.remediation).toMatch(/run the walk as the uid that owns/);
        expect(e.remediation).toMatch(/copy the store somewhere readable/);
        // Telling an operator to widen the store is the one thing it must NOT say.
        expect(e.remediation).toMatch(/never chmod the original to widen it/);
      } finally {
        chmodSync(p, 0o600);
      }
    },
  );

  // bun:sqlite's `new Database(path)` is LAZY, so the corruption surfaces on
  // the first file-touching statement, not the open. Both of those now sit
  // inside probeAndBind's classifying catch — before that, this arm was
  // unreachable and the operator got a bare SQLiteError with no remediation.
  test("audit-store-corrupt: a non-SQLite file refuses with a do-NOT-delete remediation", () => {
    const p = join(dir, "corrupt.db");
    writeFileSync(p, "this is not a sqlite database at all, 0123456789abcdef".repeat(8));
    const e = refusalOf(() => openAuditStoreForWalk(p));
    expect(e.code).toBe("audit-store-corrupt");
    expect(e.remediation).toContain(p);
    expect(e.remediation).toMatch(/do NOT delete or overwrite/);
    expect(e.remediation).toContain('".recover"');
    expect(existsSync(p)).toBeTrue();
  });

  test("happy path: probe and bind succeed on an intact store", () => {
    const p = join(dir, "audit.db");
    const store = openAuditStore(p);
    store.record(validLink());
    store.close();
    const probe = __auditStoreTestHooks.probeAuditStore(p);
    const db = __auditStoreTestHooks.probeAndBind(p, probe);
    expect(db.prepare("SELECT COUNT(*) AS n FROM audit_links").get()).toEqual({ n: 1 });
    db.close();
    probe.close();
    const reader = openAuditStoreForWalk(p);
    expect(reader.linksForRun("run-1")).toHaveLength(1);
    reader.close();
  });

  test("the walk handle APPENDS over the one inode-verified connection — never a second open", () => {
    const p = join(dir, "audit.db");
    const store = openAuditStore(p);
    store.record(validLink());
    store.close();
    const ino = statSync(p).ino;

    const walk = openAuditStoreForWalk(p);
    walk.record(
      validLink({ hop: "pr-run", event: "walk-observed", subjectId: "pr-7", occurredAt: "2026-09-16T00:00:05.000Z" }),
    );
    expect(walk.linksForRun("run-1")).toHaveLength(2);
    expect(statSync(p).ino).toBe(ino);
    // A bad link is still the CALLER's bad link — not relabelled as a missing store.
    expect(refusalOf(() => walk.record(validLink({ hop: "run-teleport" }))).code).toBe("audit-link-invalid");

    // The hazard the one-handle design exists for: a store removed since the
    // attach must NOT be silently re-created and re-migrated by the append.
    // SQLite refuses the write on the unlinked inode rather than materialising
    // a new file; the handle turns that into a typed refusal. A second by-path
    // open would instead put a fresh, migrated store at the path and the walk
    // would audit a chain it had just invented.
    rmSync(p);
    const e = refusalOf(() =>
      walk.record(
        validLink({
          hop: "run-approval",
          event: "walk-observed",
          subjectId: "ap-1",
          occurredAt: "2026-09-16T00:00:06.000Z",
        }),
      ),
    );
    expect(e.code).toBe("audit-store-identity-changed");
    expect(e.remediation).toContain(p);
    expect(existsSync(p)).toBeFalse();
    walk.close();
  });

  test("identity-changed: the store REPLACED across the probe→bind window refuses and writes nothing", () => {
    const p = join(dir, "audit.db");
    const first = openAuditStore(p);
    first.record(validLink());
    first.close();
    const probe = __auditStoreTestHooks.probeAuditStore(p);
    // Replace the INODE, not the contents: build the replacement elsewhere
    // and rename it over the probed path — the atomic replace the check
    // exists to catch.
    const alt = join(dir, "replacement.db");
    const replacement = openAuditStore(alt);
    replacement.record(validLink({ runId: "run-2" }));
    replacement.close();
    const beforeHash = fileHash(alt);
    renameSync(alt, p);

    expect(() => __auditStoreTestHooks.probeAndBind(p, probe)).toThrow(AuditStoreError);
    expect(refusalOf(() => __auditStoreTestHooks.probeAndBind(p, probe)).code).toBe("audit-store-identity-changed");
    probe.close();

    // The replacement is byte-identical and gained no digest row.
    expect(fileHash(p)).toBe(beforeHash);
    const reader = openAuditStoreForWalk(p);
    expect(reader.linksForRun("run-2")).toHaveLength(1); // what the replacement legitimately holds
    expect(reader.linksForRun("run-1")).toHaveLength(0); // the refused open wrote nothing
    reader.close();
  });

  test("identity-changed: the store REMOVED across the window refuses and recreates nothing", () => {
    const p = join(dir, "audit.db");
    const store = openAuditStore(p);
    store.record(validLink());
    store.close();
    const probe = __auditStoreTestHooks.probeAuditStore(p);
    rmSync(p);
    expect(() => __auditStoreTestHooks.probeAndBind(p, probe)).toThrow(AuditStoreError);
    expect(refusalOf(() => __auditStoreTestHooks.probeAndBind(p, probe)).code).toBe("audit-store-identity-changed");
    probe.close();
    expect(existsSync(p)).toBeFalse();
  });
});

describe("schema-absent (INV-AUDIT-6 fail-closed)", () => {
  test("a zero-byte store refuses and is left unchanged", () => {
    const p = join(dir, "empty.db");
    writeFileSync(p, "");
    expect(() => openAuditStoreForWalk(p)).toThrow(AuditStoreError);
    expect(refusalOf(() => openAuditStoreForWalk(p)).code).toBe("audit-store-schema-absent");
    expect(existsSync(p)).toBeTrue();
    expect(statSync(p).size).toBe(0);
  });

  test("a foreign-schema SQLite store refuses and is byte-identical afterwards", () => {
    const p = join(dir, "foreign.db");
    const other = new Database(p);
    other.exec("CREATE TABLE other (x)");
    other.close();
    const beforeHash = fileHash(p);
    expect(() => openAuditStoreForWalk(p)).toThrow(AuditStoreError);
    expect(refusalOf(() => openAuditStoreForWalk(p)).code).toBe("audit-store-schema-absent");
    expect(fileHash(p)).toBe(beforeHash);
  });
});

describe("write-time init", () => {
  test("first record on a fresh dir: dir 0700, file 0600, DELETE journal, no -wal/-shm siblings", () => {
    const p = join(dir, "sub", "audit.db");
    const store = openAuditStore(p);
    store.record(validLink());
    // BEFORE close: SQLite unlinks -wal/-shm on the LAST clean close, so a
    // sibling check taken afterwards passes whatever the journal mode is.
    expect(readdirSync(dirname(p)).filter((n) => n.startsWith("audit.db-"))).toEqual([]);
    expect(statSync(dirname(p)).mode & 0o777).toBe(0o700);
    expect(statSync(p).mode & 0o777).toBe(0o600);
    store.close();
    const db = new Database(p);
    try {
      // SQLite's default — the store NEVER sets WAL (DF5.4's file-set
      // assertion must be exact).
      expect(db.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "delete" });
      expect((db.prepare("SELECT COUNT(*) AS n FROM audit_links").get() as { n: number }).n).toBe(1);
    } finally {
      db.close();
    }
  });

  test("only a directory the store CREATED is chmodded — a pre-existing one keeps its mode", () => {
    const preexisting = join(dir, "preexisting");
    mkdirSync(preexisting, { recursive: true });
    chmodSync(preexisting, 0o755); // set explicitly, so the umask cannot decide
    const store = openAuditStore(join(preexisting, "audit.db"));
    store.record(validLink());
    store.close();
    // The proven live regression: chmodding the parent unconditionally turned
    // `QDS_AUDIT_DB=/tmp/x.db` into `audit-store-unavailable: EPERM … chmod '/tmp'`
    // and refused every dispatch.
    expect(statSync(preexisting).mode & 0o777).toBe(0o755);

    const made = join(dir, "made", "audit.db");
    const second = openAuditStore(made);
    second.close();
    expect(statSync(dirname(made)).mode & 0o777).toBe(0o700);
  });

  test("a PRE-EXISTING store file is tightened to 0600 on open", () => {
    const p = join(dir, "audit.db");
    const first = openAuditStore(p);
    first.record(validLink());
    first.close();
    chmodSync(p, 0o644); // a store created once under a permissive umask
    const second = openAuditStore(p);
    second.close();
    expect(statSync(p).mode & 0o777).toBe(0o600);
  });

  test("default path is QDS_AUDIT_DB, else cwd-relative .sandbox/audit.db", () => {
    expect(DEFAULT_AUDIT_DB_FILE).toBe(".sandbox/audit.db");
    const store = openAuditStore();
    store.close();
    expect(existsSync(join(dir, ".sandbox", "audit.db"))).toBeTrue();
    const envPath = join(dir, "env.db");
    process.env.QDS_AUDIT_DB = envPath;
    const envStore = openAuditStore();
    envStore.close();
    expect(existsSync(envPath)).toBeTrue();
  });

  test("an EXPLICIT path beats QDS_AUDIT_DB", () => {
    // Flipping the precedence to env-first would silently redirect every caller
    // that passes a path, including the CLI's --audit-db seam.
    const decoy = join(dir, "decoy.db");
    const explicit = join(dir, "explicit.db");
    process.env.QDS_AUDIT_DB = decoy;
    const store = openAuditStore(explicit);
    store.record(validLink());
    store.close();
    expect(existsSync(explicit)).toBeTrue();
    expect(existsSync(decoy)).toBeFalse();
  });

  test("two concurrent first-emits both land (BEGIN IMMEDIATE + busy_timeout)", async () => {
    const p = join(dir, "concurrent.db");
    const mod = join(import.meta.dir, "..", "..", "src", "audit", "link-store.ts");
    const child = (subjectId: string) =>
      Bun.spawn(
        [
          "bun",
          "-e",
          `const {openAuditStore}=await import(${JSON.stringify(mod)});` +
            `const s=openAuditStore(${JSON.stringify(p)});` +
            `s.record(${JSON.stringify(validLink({ subjectId }))});s.close();`,
        ],
        { stdout: "ignore", stderr: "pipe" },
      );
    const [a, b] = [child("key-a"), child("key-b")];
    const [ea, eb] = await Promise.all([a.exited, b.exited]);
    if (ea !== 0 || eb !== 0) {
      const err = `${await new Response(a.stderr).text()}${await new Response(b.stderr).text()}`;
      throw new Error(`concurrent first-emit failed (exit ${ea}/${eb}):\n${err}`);
    }
    expect(rowCount(p)).toBe(2);
  });
});

describe("write-time refusals (fail loud, nothing written)", () => {
  /**
   * All six validation rules share `audit-link-invalid`, so the code alone is
   * the same assertion six times — `messageRe` is what proves the INTENDED rule
   * is the one that fired.
   */
  function assertInvalid(p: string, over: Partial<AuditLinkInput>, messageRe: RegExp): void {
    const store = openAuditStore(p);
    try {
      expect(() => store.record(validLink(over))).toThrow(AuditStoreError);
      const e = refusalOf(() => store.record(validLink(over)));
      expect(e.code).toBe("audit-link-invalid");
      expect(e.message).toMatch(messageRe);
    } finally {
      store.close();
    }
    // Fail loud BEFORE anything is written: the store may exist (the writer
    // owns create-time init) but carries zero links.
    expect(rowCount(p)).toBe(0);
  }

  test("an unknown hop is refused", () => {
    assertInvalid(join(dir, "a.db"), { hop: "run-teleport", event: "mint" }, /unknown audit hop/);
  });

  test("walk-observed on an emitted hop is refused", () => {
    assertInvalid(join(dir, "b.db"), { hop: "run-box", event: "walk-observed" }, /not in hop .* vocabulary/);
  });

  test("a lifecycle event on a walker-only hop is refused", () => {
    assertInvalid(join(dir, "c.db"), { hop: "pr-run", event: "mint" }, /not in hop .* vocabulary/);
  });

  test("the four hops that carry NO rows by design refuse every event", () => {
    // An empty vocabulary is what makes "nothing emits this" a refusal rather
    // than a courtesy: a link for an event that never occurred is manufactured
    // evidence (INV-AUDIT-4).
    for (const hop of ["run-issue", "run-cost", "run-gate-evidence", "memory-retain-receipt"]) {
      assertInvalid(join(dir, `empty-${hop}.db`), { hop, event: "walk-observed" }, /carries no rows by design/);
      assertInvalid(join(dir, `empty2-${hop}.db`), { hop, event: "mint" }, /carries no rows by design/);
    }
  });

  test("a subject literally named '<none>' is refused — it collides with the sentinel", () => {
    assertInvalid(join(dir, "sentinel.db"), { subjectId: "<none>" }, /reserved sentinel/);
  });

  test("a digest that is not 64 lowercase hex is refused", () => {
    assertInvalid(join(dir, "d.db"), { evidenceDigest: "ABCDEF" }, /must be 64 lowercase hex/);
    assertInvalid(join(dir, "e.db"), { evidenceDigest: sha256Hex("x").toUpperCase() }, /must be 64 lowercase hex/);
  });

  test("every required non-empty string field is refused blank, BY NAME", () => {
    // The loop is table-driven: one field proves the loop runs, not that it
    // covers the columns the walker orders and joins on.
    for (const field of ["runId", "repoSlug", "requestId", "occurredAt", "recordedAt"] as const) {
      assertInvalid(
        join(dir, `blank-${field}.db`),
        { [field]: "" },
        new RegExp(`audit link ${field} must be a non-empty string`),
      );
    }
  });

  test("a stamp that is not canonical UTC ISO-8601 is refused, BY NAME", () => {
    // A stamp Date.parse cannot read switches the walker's ordering check OFF;
    // a non-canonical spelling sorts wrongly under `ORDER BY occurred_at` TEXT.
    const bad = ["now", "2026-13-45", "1789000000000", "2026-09-16T00:00:00+00:00"];
    bad.forEach((value, i) => {
      assertInvalid(join(dir, `iso-o-${i}.db`), { occurredAt: value }, /occurredAt must be a canonical UTC ISO-8601/);
      assertInvalid(join(dir, `iso-r-${i}.db`), { recordedAt: value }, /recordedAt must be a canonical UTC ISO-8601/);
    });
  });

  test("detail past the 8 KiB cap is refused (never truncated); exactly at the cap is accepted", () => {
    // `{"pad":"` (8) + N + `"}` (2) = N + 10 bytes.
    assertInvalid(join(dir, "f.db"), { detail: { pad: "x".repeat(8183) } }, /past the 8 KiB cap/);
    const p = join(dir, "g.db");
    const store = openAuditStore(p);
    store.record(validLink({ detail: { pad: "x".repeat(8182) } }));
    store.close();
    expect(rowCount(p)).toBe(1);
  });

  test("a detail JSON cannot express is a typed refusal, not a raw TypeError", () => {
    // The store is the trust boundary: a bigint or a cycle used to escape as a
    // driver-level TypeError, past every caller that narrows on AuditStoreError.
    assertInvalid(join(dir, "bigint.db"), { detail: { n: 1n } }, /detail is not JSON-serialisable/);
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    assertInvalid(join(dir, "cycle.db"), { detail: cyclic }, /detail is not JSON-serialisable/);
  });

  test("the cap is measured in BYTES over the CANONICAL form, not characters", () => {
    // ASCII alone cannot catch `detailJson.length`: char and byte counts agree.
    // 4092 × 'é' is 8194 bytes but only 4102 chars — a char-counted cap takes it
    // and writes ~8 KiB more to disk than the guard believes.
    const over = { pad: "é".repeat(4092) };
    expect(Buffer.byteLength(canonicalJson(over), "utf8")).toBe(8194);
    assertInvalid(join(dir, "mb-over.db"), { detail: over }, /past the 8 KiB cap/);

    const atCap = { pad: "é".repeat(4091) };
    expect(Buffer.byteLength(canonicalJson(atCap), "utf8")).toBe(8192);
    const p = join(dir, "mb-at.db");
    const store = openAuditStore(p);
    store.record(validLink({ detail: atCap }));
    store.close();
    expect(rowCount(p)).toBe(1);
  });
});

describe("linksForRun ordering", () => {
  test("ordered by occurred_at, then link_id", () => {
    const p = join(dir, "audit.db");
    const store = openAuditStore(p);
    // Recorded out of order; C and D share a millisecond stamp, so the
    // link_id (insert order) breaks the tie.
    store.record(validLink({ subjectId: "a", event: "teardown", occurredAt: "2026-09-16T00:00:03.000Z", hop: "run-box" }));
    store.record(validLink({ subjectId: "b", event: "create", occurredAt: "2026-09-16T00:00:01.000Z", hop: "run-box" }));
    store.record(validLink({ subjectId: "c", event: "fill", occurredAt: "2026-09-16T00:00:02.000Z", hop: "run-box" }));
    store.record(
      validLink({ subjectId: "d", event: "setup-gate", occurredAt: "2026-09-16T00:00:02.000Z", hop: "run-box" }),
    );
    store.close();
    const reader = openAuditStoreForWalk(p);
    expect(reader.linksForRun("run-1").map((r) => `${r.event}:${r.linkId}`)).toEqual([
      "create:2",
      "fill:3",
      "setup-gate:4",
      "teardown:1",
    ]);
    reader.close();
  });

  test("a fresh dir is created on demand and a second open reuses the store", () => {
    // No mkdirSync here: the on-demand half is the point of the test.
    const p = join(dir, "reuse", "audit.db");
    const first = openAuditStore(p);
    first.record(validLink());
    first.close();
    const second = openAuditStore(p);
    second.record(validLink({ subjectId: "key-2" }));
    second.close();
    expect(rowCount(p)).toBe(2);
  });
});
