/**
 * M1.2 Deviation 1 (binding): the reserved `memory-retain-receipt` hop gains
 * its one-event vocabulary — `["retain"]` — the adds-only row that converts
 * INV-AUDIT-4's deliberate empty-vocabulary refusal into a write-open hop.
 * These pins live beside link-store.test.ts (whose "carries no rows by design"
 * loop predates Deviation 1 and is not this file's to edit): the hop contract
 * stays closed (exactly the previous ten hops), the vocabulary stays closed
 * (exactly `retain`), and the refusal arm the emptiness used to serve now
 * rejects by vocabulary membership instead.
 *
 * Every test points `QDS_AUDIT_DB` inside its own tmpdir FIRST (C-5), the same
 * backstop link-store.test.ts uses — an accidental default-path open can never
 * resolve at the repo root.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AUDIT_HOPS,
  openAuditStore,
  sha256Hex,
  type AuditLinkInput,
  AuditStoreError,
} from "../../src/audit/link-store.ts";

let dir: string;
let prevAuditEnv: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qds-m12-vocab-"));
  prevAuditEnv = process.env.QDS_AUDIT_DB;
  process.env.QDS_AUDIT_DB = join(dir, "env-default-guard.db");
});

afterEach(() => {
  // biome-ignore lint/performance/noDelete: unsetting env vars requires delete
  if (prevAuditEnv === undefined) delete process.env.QDS_AUDIT_DB;
  else process.env.QDS_AUDIT_DB = prevAuditEnv;
  rmSync(dir, { recursive: true, force: true });
});

/** A legal receipt link (story: hop `memory-retain-receipt`, event `retain`, subject `documentId`). */
function receiptLink(over: Partial<AuditLinkInput> = {}): AuditLinkInput {
  return {
    runId: "run-1",
    repoSlug: "acme/widgets",
    requestId: "req-1",
    hop: "memory-retain-receipt",
    event: "retain",
    subjectId: "doc-1",
    subjectKind: "hindsight-document",
    evidenceDigest: sha256Hex("subject"),
    occurredAt: "2026-10-06T00:00:00.000Z",
    recordedAt: "2026-10-06T00:00:00.001Z",
    ...over,
  };
}

function storedRows(path: string): { hop: string; event: string; subject_id: string | null }[] {
  const db = new Database(path);
  try {
    return db.prepare("SELECT hop, event, subject_id FROM audit_links").all() as {
      hop: string;
      event: string;
      subject_id: string | null;
    }[];
  } finally {
    db.close();
  }
}

function rowCount(path: string): number {
  const db = new Database(path);
  try {
    return (db.prepare("SELECT COUNT(*) AS n FROM audit_links").get() as { n: number }).n;
  } finally {
    db.close();
  }
}

/** The one typed refusal a thunk raises, narrowed — captured ONCE (see link-store.test.ts). */
function refusalOf(fn: () => unknown): AuditStoreError {
  try {
    fn();
  } catch (e) {
    if (e instanceof AuditStoreError) return e;
    throw e;
  }
  throw new Error("expected an AuditStoreError, nothing was thrown");
}

describe("memory-retain-receipt vocabulary", () => {
  test("event retain is accepted and lands exactly its row", () => {
    const p = join(dir, "retain.db");
    const store = openAuditStore(p);
    store.record(receiptLink());
    store.close();
    expect(storedRows(p)).toEqual([{ hop: "memory-retain-receipt", event: "retain", subject_id: "doc-1" }]);
  });

  test("any other event on the hop is refused with the audit-link-invalid refusal", () => {
    // The vocabulary is non-empty now, so the refusal arm is the VOCABULARY
    // one — the machinery INV-AUDIT-4 used to hold this hop write-closed by
    // emptiness now rejects by membership instead, and names the one allowed
    // event in the message.
    const p = join(dir, "refused.db");
    const store = openAuditStore(p);
    try {
      for (const event of ["walk-observed", "mint", ""]) {
        const e = refusalOf(() => store.record(receiptLink({ event })));
        expect(e.code).toBe("audit-link-invalid");
        expect(e.message).toMatch(/not in hop "memory-retain-receipt"'s vocabulary \(retain\)/);
      }
    } finally {
      store.close();
    }
    // Fail loud BEFORE anything is written.
    expect(rowCount(p)).toBe(0);
  });

  test("AUDIT_HOPS still holds exactly the previous ten hops, including memory-retain-receipt", () => {
    expect([...AUDIT_HOPS]).toEqual([
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
    ]);
  });

  test("the vocabulary row is exactly [retain]: every documented event of every other hop is refused", () => {
    // `HOP_EVENT_VOCABULARY` is module-private, so exact membership is pinned
    // behaviourally: `retain` in (above); every event any OTHER hop documents,
    // plus near-miss spellings of retain, out. A future edit that grows the
    // vocabulary is named by whichever entry this loop catches.
    const p = join(dir, "exact.db");
    const store = openAuditStore(p);
    const elsewhere = [
      "mint", "deliver", "revoke", "verify-revoked", // run-credential
      "create", "fill", "setup-gate", "teardown", "reap", // run-box
      "bundle-verify", "bundle-fetch", // run-bundle
      "walk-observed", // pr-run / run-reverify / run-approval
    ];
    try {
      for (const event of [...elsewhere, "retains", "Retain"]) {
        const e = refusalOf(() => store.record(receiptLink({ event })));
        expect(e.code).toBe("audit-link-invalid");
        expect(e.message).toMatch(/not in hop "memory-retain-receipt"'s vocabulary \(retain\)/);
      }
    } finally {
      store.close();
    }
    expect(rowCount(p)).toBe(0);
  });
});
