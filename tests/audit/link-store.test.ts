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
 * Every test points `QDS_AUDIT_DB` inside its own tmpdir FIRST (C-5), so an
 * accidental default-path open can never resolve at the repo root — the real
 * `.sandbox/` is never touched. Only the one test that exercises the cwd-
 * relative default chdirs, and it does so inside its own `try/finally`.
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
let prevAuditEnv: string | undefined;
let prevUmask: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qds-df53-links-"));
  prevAuditEnv = process.env.QDS_AUDIT_DB;
  // C-5 backstop. `process.chdir` used to serve this role, but it is
  // PROCESS-global: bun loads every test file into one process, so for the
  // duration of this file any other module's relative-path resolution — and
  // any async work still in flight from an earlier file — resolved against a
  // directory `afterEach` then deleted, surfacing as an ENOENT attributed to
  // the wrong suite. Every test here passes an absolute path; this env default
  // catches the one that ever stops doing so.
  process.env.QDS_AUDIT_DB = join(dir, "env-default-guard.db");
  // The create-path mode assertions (dir 0700, file 0600) are checked on paths
  // the store just created, and `mkdir`/SQLite create at `0777 & ~umask` /
  // `0644 & ~umask`. Under an inherited `umask 077` — common on hardened CI
  // images — both land on 0700/0600 with the production `chmod` calls DELETED,
  // so the inherited value silently decided whether they tested anything. At
  // umask 0 only an explicit chmod can produce them. (The two PRE-EXISTING-path
  // mode tests already handle this with explicit `chmodSync`; this is the same
  // intent for the pair that was left umask-dependent.)
  prevUmask = process.umask(0o000);
});

afterEach(() => {
  process.umask(prevUmask);
  // biome-ignore lint/performance/noDelete: unsetting env vars requires delete
  if (prevAuditEnv === undefined) delete process.env.QDS_AUDIT_DB;
  else process.env.QDS_AUDIT_DB = prevAuditEnv;
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

/**
 * The one typed refusal a thunk raises, narrowed.
 *
 * `refusalOf` already rethrows anything that is not an `AuditStoreError`, so a
 * preceding `expect(() => …).toThrow(AuditStoreError)` is redundant — and it
 * ran the failing operation a SECOND time. For the openers that meant two probe
 * `Database` handles opened on a corrupt/foreign file and abandoned unclosed on
 * the throwing path (bun:sqlite handles are only GC-finalised); for `record` it
 * meant the `audit-link.record` error line emitted twice into the suite's real
 * log sink, multiplied by 16 in the vocabulary test. Capture ONCE and assert on
 * the captured value.
 */
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

    // The STRICT form the sibling idempotence test uses: `find` alone passed an
    // implementation that logged an `inserted` line AND a `divergent` line for
    // one rejected re-emit — an operator reconstructing a chain from the log
    // would then see two emits against one row and could not tell which lied.
    expect(lines.map((l) => [l.outcome, l.status])).toEqual([["divergent", "error"]]);
    const divergent = lines[0];
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
    try {
      // The sentinel is now REFUSED on the read side too. The write-side
      // refusal keeps a real `"<none>"` subject out of the store, but it cannot
      // stop a CALLER passing the sentinel to the reader — and answering "does
      // a link exist for subject <none>?" with the subject-LESS row is a true
      // answer to a different question, shipped as a trap for DF5.4-C9, which
      // is the only reason `linkExists` is exported at all.
      const e = refusalOf(() => reader.linkExists("run-1", "run-credential", "mint", "<none>"));
      expect(e.code).toBe("audit-link-invalid");
      expect(e.message).toContain("reserved sentinel");
    } finally {
      reader.close(); // the throw is mid-test now; the close must stay reachable
    }
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
      // The EXACT string, not `JSON.parse` + `toEqual`: that pair is order-
      // blind, so it passed for `'{"b":1,"a":2}'` and `'{"a":2,"b":1}'` alike —
      // and the fixture `{ b: 1, a: 2 }` was chosen precisely to expose the
      // sort. A `record()` that stopped canonicalising and persisted insertion
      // order kept this green while the digest preimage on disk changed.
      expect(row.detail_json).toBe('{"a":2,"b":1}');
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
    // The sort is by CODE UNIT (`keys.sort()`), not by locale. Every other
    // fixture in this file and in audit-emit.test.ts is lowercase-initial, and
    // `a` sorts before `é` under both comparators — so a `localeCompare` or
    // `Intl.Collator` implementation passed the entire suite. It must not:
    // `localeCompare` is ICU/locale-sensitive, so `{Box: …, appId: …}` would
    // digest differently depending on `LANG`/ICU build between the emitting
    // host and the walking host (or between driver.ts's copy and this one) —
    // a PERMANENT, unfixable `evidence-mismatch` on an append-only store.
    expect(canonicalJson({ a: 1, B: 2 })).toBe('{"B":2,"a":1}'); // 0x42 < 0x61
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
    const e = refusalOf(() => openAuditStoreForWalk(p));
    expect(e).toBeInstanceOf(AuditStoreError);
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
    expect(refusalOf(() => __auditStoreTestHooks.probeAndBind(p, probe)).code).toBe("audit-store-identity-changed");
    probe.close();
    expect(existsSync(p)).toBeFalse();
  });
});

describe("schema-absent (INV-AUDIT-6 fail-closed)", () => {
  test("a zero-byte store refuses and is left unchanged", () => {
    const p = join(dir, "empty.db");
    writeFileSync(p, "");
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
    // The ONE test that needs the cwd, so it owns the chdir — scoped, restored
    // in a `finally`, and never left on the process for the rest of the file.
    const prevCwd = process.cwd();
    process.chdir(dir);
    try {
      // biome-ignore lint/performance/noDelete: unsetting env vars requires delete
      delete process.env.QDS_AUDIT_DB; // the cwd-relative arm is the no-env one
      const store = openAuditStore();
      store.close();
      expect(existsSync(join(dir, ".sandbox", "audit.db"))).toBeTrue();
      const envPath = join(dir, "env.db");
      process.env.QDS_AUDIT_DB = envPath;
      const envStore = openAuditStore();
      envStore.close();
      expect(existsSync(envPath)).toBeTrue();
    } finally {
      process.chdir(prevCwd);
    }
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

  test("a writer HELD OUT by an open BEGIN IMMEDIATE still lands its row (busy_timeout, deterministically)", async () => {
    // The old shape spawned two children and asserted both exited 0. Nothing
    // synchronised them at the write: each paid a cold bun start plus a TS
    // import before touching SQLite and then wrote one tiny row inside one
    // transaction, so two sub-millisecond write windows essentially never
    // overlapped. It was green with `busy_timeout` DELETED — and it asserted
    // nothing about contention having occurred. A regression that drops the
    // timeout loses an audit link to SQLITE_BUSY on an append-only store where
    // it can never be re-added under the same identity.
    //
    // Deterministic form: the PARENT holds a write lock open for a fixed
    // window, the child must wait it out, and the child's row is what proves
    // it did. With `busy_timeout` removed the child fails immediately with
    // SQLITE_BUSY and this goes red every time.
    const p = join(dir, "concurrent.db");
    const seed = openAuditStore(p); // create + migrate first, so the child only writes
    seed.record(validLink({ subjectId: "key-seed" }));
    seed.close();

    const mod = join(import.meta.dir, "..", "..", "src", "audit", "link-store.ts");
    const proc = Bun.spawn(
      [
        "bun",
        "-e",
        `const {openAuditStore}=await import(${JSON.stringify(mod)});` +
          `const s=openAuditStore(${JSON.stringify(p)});` +
          `s.record(${JSON.stringify(validLink({ subjectId: "key-child" }))});s.close();`,
      ],
      { stdout: "pipe", stderr: "pipe", env: { ...process.env, QDS_AUDIT_DB: p } },
    );

    const holder = new Database(p);
    let held = 0;
    try {
      holder.exec("BEGIN IMMEDIATE"); // the parent now owns the write lock
      const until = Date.now() + 200;
      while (Date.now() < until) Bun.sleepSync(10); // hold it across the child's write attempt
      held = Date.now();
      holder.exec("COMMIT");
    } finally {
      holder.close();
    }

    // Drain BOTH pipes BEFORE awaiting exit. A child writing more than the OS
    // pipe buffer (~64 KiB — a bun resolve/transpile stack, a SQLite
    // diagnostic) blocks on write, `exited` never resolves, and the test hangs
    // until timeout with the diagnostic still stuck in the pipe.
    const [exit, out, err] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    if (exit !== 0) throw new Error(`held-out writer failed (exit ${exit}):\n${out}${err}`);

    expect(held).toBeGreaterThan(0);
    // The child's row landed despite the ~200 ms lock: contention happened and
    // `busy_timeout` absorbed it.
    expect(rowCount(p)).toBe(2);
    const db = new Database(p);
    try {
      const subjects = (db.prepare("SELECT subject_id FROM audit_links ORDER BY link_id").all() as { subject_id: string }[])
        .map((r) => r.subject_id);
      expect(subjects).toEqual(["key-seed", "key-child"]);
    } finally {
      db.close();
    }
  }, 30_000);
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
      const e = refusalOf(() => store.record(validLink(over)));
      expect(e).toBeInstanceOf(AuditStoreError);
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
    const atCap = { pad: "x".repeat(8182) };
    store.record(validLink({ detail: atCap }));
    store.close();
    expect(rowCount(p)).toBe(1);
    // "never truncated" is in the test NAME and was never asserted: `rowCount`
    // cannot tell a whole store from one that accepted the detail and wrote
    // `{"pad":"xxx…[truncated]"}`. A truncated `detail_json` is no longer the
    // digest preimage, so the walker reports a permanent `evidence-mismatch` on
    // a link that was legitimately accepted — at the one input size most likely
    // to trip a truncating path.
    expect(readRow(p).detail_json).toBe(canonicalJson(atCap));
    expect(Buffer.byteLength(readRow(p).detail_json as string, "utf8")).toBe(8_192);
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
    // Read back whole, same reason as the ASCII half above.
    expect(readRow(p).detail_json).toBe(canonicalJson(atCap));
    expect(Buffer.byteLength(readRow(p).detail_json as string, "utf8")).toBe(8_192);
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

describe("structured lines for the REFUSED paths", () => {
  test("a validation refusal emits an audit-link.record error line naming the code, then rethrows", () => {
    // Every other outcome of `record()` emits an `audit-link.record` line —
    // inserted, duplicate, divergent. A refusal emitted NOTHING, so an operator
    // grepping that operation for a run saw only the emits that landed: a
    // validator throwing out every link of a run was indistinguishable from an
    // emitter that never fired at all.
    const p = join(dir, "audit.db");
    const store = openAuditStore(p);
    let thrown: unknown;
    const lines = capturedLines(() => {
      try {
        store.record(validLink({ occurredAt: "2026-09-16 01:00:00+00:00" })); // non-canonical
      } catch (e) {
        thrown = e;
      }
    });
    store.close();

    // The throw is unchanged — the line is purely additive.
    expect(thrown).toBeInstanceOf(AuditStoreError);
    expect((thrown as AuditStoreError).code).toBe("audit-link-invalid");
    // ...and nothing was written.
    expect(rowCount(p)).toBe(0);

    const line = lines.find((l) => l.operation === "audit-link.record");
    expect(line).toBeDefined();
    expect(line?.status).toBe("error");
    expect(line?.outcome).toBe("audit-link-invalid");
    // The join columns ride along so the line is greppable by run like the rest.
    expect(line?.runId).toBe(validLink().runId);
    expect(line?.hop).toBe(validLink().hop);
    expect(String(line?.message)).toContain("audit link refused");
  });

  test("the refusal line carries NEITHER the validator's message nor an unbounded join column", () => {
    // The two halves of INV-AUDIT-2 on this line, pinned together because they
    // are the same leak:
    //
    //  1. `invalidLink` messages quote the REJECTED INPUT back (`got
    //     ${JSON.stringify(value)}`), and `detail` is a payload field that
    //     carries prompt content by design. Interpolating that message into the
    //     line put caller bytes into the engine log, which rides the harvest
    //     tar. The `outcome` code is the machine-readable half and stays; the
    //     human half lives on the THROW, which goes to the caller only.
    //  2. The join columns are unvalidated HERE by definition — the validator
    //     already threw — so a 4 MiB `hop`, or one full of control characters,
    //     reached the log verbatim.
    const p = join(dir, "audit.db");
    const store = openAuditStore(p);
    const secret = "sk-live-SHOULD-NEVER-REACH-THE-LOG";
    const lines = capturedLines(() => {
      expect(() =>
        // Refused on the digest; the junk `runId` and the secret-bearing
        // `subjectId` ride along as the fields the line must NOT echo.
        store.record(
          validLink({
            evidenceDigest: "not-a-digest",
            runId: `run\u001b[2J${"x".repeat(500)}`,
            subjectId: secret,
          }),
        ),
      ).toThrow(AuditStoreError);
    });
    store.close();

    const line = lines.find((l) => l.operation === "audit-link.record");
    expect(line?.status).toBe("error");
    expect(line?.outcome).toBe("audit-link-invalid");
    // The message is FIXED — not the validator's, which quotes "not-a-digest".
    expect(line?.message).toBe("audit link refused");
    // Nothing anywhere on the line quotes the rejected input or the secret.
    const whole = JSON.stringify(line);
    expect(whole).not.toContain(secret);
    expect(whole).not.toContain("not-a-digest");
    // The join column is still THERE (the line must stay greppable by run) but
    // bounded and stripped.
    expect(String(line?.runId).length).toBeLessThanOrEqual(120);
    expect(String(line?.runId)).toStartWith("run");
    expect(String(line?.runId)).not.toContain("\u001b");
    expect(rowCount(p)).toBe(0);
  });

  test("a refusal whose join column is a NON-STRING is reported as a shape, never serialised", () => {
    // `runId` is typed `string`, but this is the provider trust boundary and
    // the validator has already thrown by the time the line is built — so a
    // caller that passed an object got it `JSON.stringify`d into the log whole.
    const p = join(dir, "audit.db");
    const store = openAuditStore(p);
    const lines = capturedLines(() => {
      expect(() =>
        store.record(validLink({ runId: { token: "sk-live-nested" } as unknown as string })),
      ).toThrow(AuditStoreError);
    });
    store.close();
    const line = lines.find((l) => l.operation === "audit-link.record");
    expect(line?.runId).toBe("<non-string: object>");
    expect(JSON.stringify(line)).not.toContain("sk-live-nested");
    expect(rowCount(p)).toBe(0);
  });

  test("a refusal whose requestId is ITSELF invalid still emits a line (with a minted log id)", () => {
    // `emitLine` needs a requestId, and an empty one is exactly the failure this
    // arm reports — so the line falls back to a minted id. That id is the LOG's
    // correlation only; nothing is written to audit_links, so no fabricated join
    // key can reach the store (INV-AUDIT-4).
    const p = join(dir, "audit.db");
    const store = openAuditStore(p);
    const lines = capturedLines(() => {
      expect(() => store.record(validLink({ requestId: "" }))).toThrow();
    });
    store.close();
    const line = lines.find((l) => l.operation === "audit-link.record");
    expect(line?.status).toBe("error");
    expect(typeof line?.requestId).toBe("string");
    expect(String(line?.requestId).length).toBeGreaterThan(0);
    expect(rowCount(p)).toBe(0);
  });

  test("openAuditStoreForWalk emits an audit-store.open error line when the PROBE fails", () => {
    // `audit-store-absent` is the commonest refusal this opener has, and it was
    // the ONE that emitted no open line: the walk's structured log jumped
    // straight from "walk started" to hops 4/5/6 broken, with no record that the
    // store had been reached for at all.
    const missing = join(dir, "nope", "audit.db");
    const lines = capturedLines(() => {
      const e = refusalOf(() => openAuditStoreForWalk(missing));
      expect(e.code).toBe("audit-store-absent");
    });
    const line = lines.find((l) => l.operation === "audit-store.open");
    expect(line).toBeDefined();
    expect(line?.status).toBe("error");
    expect(line?.outcome).toBe("audit-store-absent");
    expect(line?.auditPath).toBe(missing);
  });
});
