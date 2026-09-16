/**
 * DF5.3 audit-link store TDD.
 *
 * Clause map (story Tests + DoD "the walker never creates the store it
 * audits"):
 * - redelivery idempotence on the COALESCE sentinel (NULLs-distinct trap)
 * - immutability: UPDATE/DELETE abort via trigger, row unchanged (INV-AUDIT-4)
 * - emit-time digest: the store digests nothing; canonicalJson/sha256Hex
 * - audit-store-absent: typed refusal, path still absent (existsSync, not logs)
 * - identity window: replace-and-restore and removal across the probe→bind
 *   window refuse `audit-store-identity-changed`, write nothing, byte-identical
 * - schema-absent: zero-byte and foreign-schema stores refuse fail-closed
 * - write-time init: dir 0700, file 0600, DELETE journal, no -wal/-shm siblings
 * - write-time vocabulary, digest shape, detail cap (fail loud, nothing written)
 * - linksForRun ordering: occurred_at then link_id
 *
 * Every test chdirs into its own tmpdir FIRST so the default store path can
 * never resolve at the repo root — the real `.sandbox/` is never touched.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
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
  AuditStoreError,
} from "../../src/audit/link-store.ts";

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

function fileHash(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

describe("redelivery idempotence", () => {
  test("an identical (run_id, hop, event, subject_id) redelivery leaves ONE row", () => {
    const p = join(dir, "audit.db");
    const store = openAuditStore(p);
    store.record(validLink());
    store.record(validLink());
    store.close();
    expect(rowCount(p)).toBe(1);
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

  test("DELETE aborts and the row survives", () => {
    const p = join(dir, "audit.db");
    const store = openAuditStore(p);
    store.record(validLink());
    store.close();
    const db = new Database(p);
    try {
      expect(() => db.exec("DELETE FROM audit_links")).toThrow(/append-only/);
      expect((db.prepare("SELECT COUNT(*) AS n FROM audit_links").get() as { n: number }).n).toBe(1);
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
    expect(canonicalJson({ n: null, u: undefined })).toBe('{"n":null,"u":null}');
  });

  test("sha256Hex matches the known vector", () => {
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("no-create walk opener", () => {
  test("audit-store-absent: typed refusal and the path STILL does not exist", () => {
    const p = join(dir, "never-created.db");
    expect(() => openAuditStoreForWalk(p)).toThrow(AuditStoreError);
    try {
      openAuditStoreForWalk(p);
      expect.unreachable();
    } catch (e) {
      expect((e as AuditStoreError).code).toBe("audit-store-absent");
      expect(typeof (e as AuditStoreError).remediation).toBe("string");
    }
    // Checked on the filesystem, not in a log.
    expect(existsSync(p)).toBeFalse();
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
    try {
      __auditStoreTestHooks.probeAndBind(p, probe);
      expect.unreachable();
    } catch (e) {
      expect((e as AuditStoreError).code).toBe("audit-store-identity-changed");
    }
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
    try {
      __auditStoreTestHooks.probeAndBind(p, probe);
      expect.unreachable();
    } catch (e) {
      expect((e as AuditStoreError).code).toBe("audit-store-identity-changed");
    }
    probe.close();
    expect(existsSync(p)).toBeFalse();
  });
});

describe("schema-absent (INV-AUDIT-6 fail-closed)", () => {
  test("a zero-byte store refuses and is left unchanged", () => {
    const p = join(dir, "empty.db");
    writeFileSync(p, "");
    expect(() => openAuditStoreForWalk(p)).toThrow(AuditStoreError);
    try {
      openAuditStoreForWalk(p);
      expect.unreachable();
    } catch (e) {
      expect((e as AuditStoreError).code).toBe("audit-store-schema-absent");
    }
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
    try {
      openAuditStoreForWalk(p);
      expect.unreachable();
    } catch (e) {
      expect((e as AuditStoreError).code).toBe("audit-store-schema-absent");
    }
    expect(fileHash(p)).toBe(beforeHash);
  });
});

describe("write-time init", () => {
  test("first record on a fresh dir: dir 0700, file 0600, DELETE journal, no -wal/-shm siblings", () => {
    const p = join(dir, "sub", "audit.db");
    const store = openAuditStore(p);
    store.record(validLink());
    store.close();
    expect(statSync(dirname(p)).mode & 0o777).toBe(0o700);
    expect(statSync(p).mode & 0o777).toBe(0o600);
    const db = new Database(p);
    try {
      // SQLite's default — the store NEVER sets WAL (DF5.4's file-set
      // assertion must be exact).
      expect(db.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "delete" });
      expect((db.prepare("SELECT COUNT(*) AS n FROM audit_links").get() as { n: number }).n).toBe(1);
    } finally {
      db.close();
    }
    expect(readdirSync(dirname(p)).filter((n) => n.startsWith("audit.db-"))).toEqual([]);
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
});

describe("write-time vocabulary (fail loud, nothing written)", () => {
  function assertInvalid(p: string, over: Partial<AuditLinkInput>): void {
    const store = openAuditStore(p);
    try {
      expect(() => store.record(validLink(over))).toThrow(AuditStoreError);
      try {
        store.record(validLink(over));
        expect.unreachable();
      } catch (e) {
        expect((e as AuditStoreError).code).toBe("audit-link-invalid");
      }
    } finally {
      store.close();
    }
    // Fail loud BEFORE anything is written: the store may exist (the writer
    // owns create-time init) but carries zero links.
    expect(rowCount(p)).toBe(0);
  }

  test("an unknown hop is refused", () => {
    assertInvalid(join(dir, "a.db"), { hop: "run-teleport", event: "mint" });
  });

  test("walk-observed on an emitted hop is refused", () => {
    assertInvalid(join(dir, "b.db"), { hop: "run-box", event: "walk-observed" });
  });

  test("a lifecycle event on a walker-only hop is refused", () => {
    assertInvalid(join(dir, "c.db"), { hop: "pr-run", event: "mint" });
  });

  test("a digest that is not 64 lowercase hex is refused", () => {
    assertInvalid(join(dir, "d.db"), { evidenceDigest: "ABCDEF" });
    assertInvalid(join(dir, "e.db"), { evidenceDigest: sha256Hex("x").toUpperCase() });
  });

  test("detail past the 8 KiB cap is refused (never truncated); exactly at the cap is accepted", () => {
    // `{"pad":"` (8) + N + `"}` (2) = N + 10 bytes.
    assertInvalid(join(dir, "f.db"), { detail: { pad: "x".repeat(8183) } });
    const p = join(dir, "g.db");
    const store = openAuditStore(p);
    store.record(validLink({ detail: { pad: "x".repeat(8182) } }));
    store.close();
    expect(rowCount(p)).toBe(1);
  });

  test("a blank runId is refused", () => {
    assertInvalid(join(dir, "h.db"), { runId: "" });
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
    mkdirSync(join(dir, "reuse"), { recursive: true });
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
