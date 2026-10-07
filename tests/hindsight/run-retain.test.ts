/**
 * M1.2 AC4/AC6 — run-retain: documentId determinism, payload bound + structure,
 * replace-dedup, receipt shape/dedup on the REAL audit store, best-effort
 * receipt, and the negative controls (no prose channel, no time-based
 * documentId, no per-run credential parameter).
 *
 * The store legs run the real `openAuditStore` on a tmpdir DB (the link-store
 * test pattern); every test points `QDS_AUDIT_DB` inside its own tmpdir FIRST
 * (C-5) so an accidental default-path open can never resolve at the repo root.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  canonicalJson,
  openAuditStore,
  sha256Hex,
  type AuditStoreWriter,
} from "../../src/audit/link-store.ts";
import { setLogSink, type LogEntry } from "../../src/swarmclaw/mcp/stdio-transport.ts";
import type { HindsightClient } from "../../src/hindsight/client.ts";
import {
  RETAIN_PAYLOAD_MAX_BYTES,
  RunRetainError,
  buildRetainPayload,
  deriveDocumentId,
  retainRunOutcome,
  type RetainOutcome,
  type RunRetainInput,
} from "../../src/hindsight/run-retain.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let dir: string;
let prevAuditEnv: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qds-m12-run-retain-"));
  prevAuditEnv = process.env.QDS_AUDIT_DB;
  process.env.QDS_AUDIT_DB = join(dir, "env-default-guard.db");
});

afterEach(() => {
  // biome-ignore lint/performance/noDelete: unsetting env vars requires delete
  if (prevAuditEnv === undefined) delete process.env.QDS_AUDIT_DB;
  else process.env.QDS_AUDIT_DB = prevAuditEnv;
  rmSync(dir, { recursive: true, force: true });
});

const RUN_ID = "qds-20261006-ab12cd";

/** A fully-populated realistic outcome. */
function outcome(over: Partial<RetainOutcome> = {}): RetainOutcome {
  return {
    runId: RUN_ID,
    repoSlug: "acme/widgets",
    requestId: "req-retain-1",
    exitClassification: "green",
    harvestedCount: 3,
    spendMicroUsd: 41_250,
    bundlePath: ".sandbox/bundles/qds-20261006-ab12cd.tar.zst",
    tags: ["run-outcome", "acme/widgets"],
    ...over,
  };
}

function runInput(over: Partial<RunRetainInput> = {}): RunRetainInput {
  return { ...outcome(), repoBankId: "qds-acme-widgets", ...over };
}

type RetainMetadata = Parameters<HindsightClient["retain"]>[2];

interface CapturedRetain {
  bankId: string;
  content: string;
  metadata?: RetainMetadata;
}

/** Fake client: captures every retain call, returns the schema-valid view. */
function fakeClient() {
  const calls: CapturedRetain[] = [];
  const client = {
    retain: async (bankId: string, content: string, metadata?: RetainMetadata) => {
      calls.push({ bankId, content, metadata });
      return { memoryId: "", bankId, status: "created" as const, durationMs: 0 };
    },
  };
  return { calls, client: client as unknown as Pick<HindsightClient, "retain"> };
}

/** Install a capturing sink; returns the restore thunk. */
function captureLog(): { lines: LogEntry[]; restore: () => void } {
  const lines: LogEntry[] = [];
  const restore = setLogSink((entry) => lines.push(entry));
  return { lines, restore };
}

interface StoredRow {
  hop: string;
  event: string;
  subject_id: string | null;
  subject_kind: string | null;
  evidence_digest: string;
  detail_json: string | null;
}

function storedRows(path: string): StoredRow[] {
  const db = new Database(path);
  try {
    return db
      .prepare(
        "SELECT hop, event, subject_id, subject_kind, evidence_digest, detail_json FROM audit_links",
      )
      .all() as StoredRow[];
  } finally {
    db.close();
  }
}

/** The canonical retain identity the receipt's evidence digest is taken over. */
function identityDigest(bank: string, documentId: string, contentDigest: string): string {
  return sha256Hex(canonicalJson({ bank, documentId, contentDigest }));
}

// ---------------------------------------------------------------------------
// "run retain" — the happy path and its idempotency contract
// ---------------------------------------------------------------------------

describe("run retain", () => {
  test("documentId is deterministic — exactly the validated runId, every time", () => {
    expect(deriveDocumentId(RUN_ID)).toBe(RUN_ID);
    // Determinism: no clock, no randomness — the same runId derives the same
    // documentId forever, which is what makes a replay a replace.
    expect(deriveDocumentId(RUN_ID)).toBe(deriveDocumentId(RUN_ID));
    expect(deriveDocumentId("qds-19991231-000000")).toBe("qds-19991231-000000");
  });

  test("payload is deterministic, canonical (sorted keys), and within the byte bound", () => {
    const input = runInput();
    const first = buildRetainPayload(input);
    expect(buildRetainPayload(input)).toBe(first);
    // Canonical: the serialised bytes ARE the canonical form — key order cannot
    // drift between two builds of the same input.
    expect(first).toBe(canonicalJson(JSON.parse(first)));
    expect(Buffer.byteLength(first, "utf8")).toBeLessThanOrEqual(RETAIN_PAYLOAD_MAX_BYTES);
  });

  test("byte-identical replay: two retains produce identical documentId + payload (replace, no duplicate)", async () => {
    const { calls, client } = fakeClient();
    const input = runInput();
    const first = await retainRunOutcome(client, undefined, input);
    const second = await retainRunOutcome(client, undefined, input);
    expect(first).toEqual({
      retained: true,
      documentId: RUN_ID,
      bank: "qds-acme-widgets",
      contentDigest: sha256Hex(buildRetainPayload(input)),
    });
    expect(second).toEqual(first);
    expect(calls.length).toBe(2);
    const [firstCall, secondCall] = calls;
    if (!firstCall || !secondCall) throw new Error("expected both retains to be captured");
    // The wire saw the SAME identity twice: same documentId, same payload, same
    // replace mode — the substrate's document_id upsert collapses these.
    expect(secondCall).toEqual(firstCall);
    expect(firstCall.bankId).toBe("qds-acme-widgets");
    expect(firstCall.metadata).toEqual({
      documentId: RUN_ID,
      updateMode: "replace",
      tags: outcome().tags,
      kind: "observation",
      source: "agent",
    });
  });

  test("receipt row shape: hop/event/subject/digest over the canonical identity, detail carries documentId + bank", async () => {
    const p = join(dir, "receipt.db");
    const store = openAuditStore(p);
    try {
      const { client } = fakeClient();
      const input = runInput();
      const result = await retainRunOutcome(client, store, input);
      const rows = storedRows(p);
      expect(rows.length).toBe(1);
      const row = rows[0];
      if (row === undefined) throw new Error("expected the receipt row to exist");
      expect(row.hop).toBe("memory-retain-receipt");
      expect(row.event).toBe("retain");
      expect(row.subject_id).toBe(RUN_ID);
      expect(row.subject_kind).toBe("document");
      expect(row.evidence_digest).toBe(identityDigest(result.bank, result.documentId, result.contentDigest));
      expect(JSON.parse(row.detail_json as string)).toEqual({ documentId: RUN_ID, bank: "qds-acme-widgets" });
      // The detail is digest-stable AND far under the store's 8 KiB cap.
      expect(Buffer.byteLength(row.detail_json as string, "utf8")).toBeLessThanOrEqual(8192);
    } finally {
      store.close();
    }
  });

  test("receipt dedup on replay: a byte-identical re-retain leaves exactly ONE row", async () => {
    const p = join(dir, "dedup.db");
    const store = openAuditStore(p);
    try {
      const { client } = fakeClient();
      const input = runInput();
      await retainRunOutcome(client, store, input);
      await retainRunOutcome(client, store, input);
      expect(storedRows(p).length).toBe(1);
    } finally {
      store.close();
    }
  });

  test("divergent content under the same documentId fires the tamper alarm: no throw, row stands with the FIRST digest", async () => {
    const p = join(dir, "divergent.db");
    const store = openAuditStore(p);
    const { lines, restore } = captureLog();
    try {
      const { client } = fakeClient();
      const first = await retainRunOutcome(client, store, runInput({ harvestedCount: 3 }));
      // Same documentId (same runId), DIFFERENT content — exactly the anomaly
      // the store's divergent-evidence check exists to surface (INV-KG-4).
      const second = await retainRunOutcome(client, store, runInput({ harvestedCount: 7 }));
      expect(second.contentDigest).not.toBe(first.contentDigest);
      // The store did NOT throw and did NOT overwrite: the first row stands.
      const rows = storedRows(p);
      expect(rows.length).toBe(1);
      const standing = rows[0];
      if (standing === undefined) throw new Error("expected the first receipt row to stand");
      expect(standing.evidence_digest).toBe(identityDigest(first.bank, first.documentId, first.contentDigest));
      // The alarm is the store's own error line naming the divergence.
      const divergent = lines.filter(
        (l) => l.operation === "audit-link.record" && l.status === "error" && l.outcome === "divergent",
      );
      expect(divergent.length).toBe(1);
    } finally {
      restore();
      store.close();
    }
  });

  test("best-effort receipt: a refusing store never fails the landed retain — refusal logged", async () => {
    const refusing: AuditStoreWriter = {
      path: join(dir, "refusing.db"),
      record() {
        throw new RunRetainError("retain-payload-invalid", "audit-link-invalid: refused by the test store");
      },
      close() {},
    };
    const { lines, restore } = captureLog();
    try {
      const { calls, client } = fakeClient();
      const result = await retainRunOutcome(client, refusing, runInput());
      // The retain landed; only the receipt was refused.
      expect(result.retained).toBe(true);
      expect(calls.length).toBe(1);
      // Both contract lines exist: the success line AND the refusal.
      const ok = lines.find((l) => l.operation === "memory-retain" && l.status === "ok");
      expect(ok).toBeDefined();
      const refusal = lines.find((l) => l.operation === "memory-retain-receipt" && l.status === "error");
      expect(refusal).toBeDefined();
      expect(refusal?.error?.message).toMatch(/refused by the test store/);
    } finally {
      restore();
    }
  });

  test("receipt-refusal message is the twins' posture: stringified, redacted, bounded to 200 [G5]", async () => {
    const secret = "sk-test0123456789abcdef";
    // Prose tail (space-separated words) so it survives redaction and the
    // 200-char bound is what actually truncates it.
    const longTail = "word ".repeat(60);
    const refusing: AuditStoreWriter = {
      path: join(dir, "refusing-redact.db"),
      record() {
        throw new Error(`leaked ${secret} then ${longTail}`);
      },
      close() {},
    };
    const { lines, restore } = captureLog();
    try {
      const { client } = fakeClient();
      await retainRunOutcome(client, refusing, runInput());
      const refusal = lines.find((l) => l.operation === "memory-retain-receipt" && l.status === "error");
      expect(refusal).toBeDefined();
      const message = refusal?.error?.message;
      expect(typeof message).toBe("string");
      // Bounded: never the raw 300+ char tail.
      expect((message as string).length).toBe(200);
      // Redacted: the secret-shaped token is gone from the line entirely.
      expect(message).not.toContain(secret);
    } finally {
      restore();
    }
  });

  test("a throwing log sink never converts a landed retain into a failure or drops the receipt [G5]", async () => {
    const restore = setLogSink(() => {
      throw new Error("sink exploded");
    });
    const p = join(dir, "throwing-sink.db");
    const store = openAuditStore(p);
    try {
      const { calls, client } = fakeClient();
      // Both contract lines (success + receipt) go to the throwing sink; neither
      // may surface as a rejection, and the receipt row must still be recorded.
      const result = await retainRunOutcome(client, store, runInput());
      expect(result.retained).toBe(true);
      expect(calls.length).toBe(1);
      expect(storedRows(p).length).toBe(1);
    } finally {
      restore();
      store.close();
    }
  });

  test("the memory-retain log line carries the Observability Contract shape", async () => {
    const { lines, restore } = captureLog();
    try {
      const { client } = fakeClient();
      const result = await retainRunOutcome(client, undefined, runInput());
      const line = lines.find((l) => l.operation === "memory-retain");
      expect(line).toBeDefined();
      expect(line).toMatchObject({
        runId: RUN_ID,
        documentId: result.documentId,
        bank: result.bank,
        contentDigest: result.contentDigest,
        status: "ok",
      });
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// "run retain negative controls" — the fences, each proven by refusal
// ---------------------------------------------------------------------------

describe("run retain negative controls", () => {
  test("the G14 bounds cap the payload far under the byte ceiling — oversize is unreachable from valid input", () => {
    const { calls } = fakeClient();
    // Every payload string field at its G14 bound builds clean and the
    // serialised bytes stay well under the ceiling: the shape bounds turned the
    // 4 KiB refusal into defense-in-depth (nothing valid can reach it — the
    // pre-G14 filler field, an unbounded correlation id, no longer exists).
    const maxBounded = runInput({
      repoSlug: "a".repeat(200),
      requestId: `${"a".repeat(63)}0`,
      bundlePath: `/${"b".repeat(511)}`,
    });
    const json = buildRetainPayload(maxBounded);
    expect(Buffer.byteLength(json, "utf8")).toBeLessThanOrEqual(RETAIN_PAYLOAD_MAX_BYTES);
    // Sanity: the bounds still bind — one char past either shape bound refuses
    // (covered in detail by the [G14] bounds test below).
    expect(() => buildRetainPayload(runInput({ repoSlug: "a".repeat(201) }))).toThrow(RunRetainError);
    expect(calls.length).toBe(0);
  });

  test("the payload has NO prose channel: exactly the structured fields, extra input properties cannot enter", () => {
    // A caller smuggling an extra (prose-bearing) property cannot get it into
    // the payload: the builder's exact-shape literal never reads it.
    const smuggled = runInput({ requestId: "req-retain-1" }) as RunRetainInput & { boxProse?: string };
    smuggled.boxProse = "RAW BOX OUTPUT: the agent wrote pages of prose here…";
    const parsed = JSON.parse(buildRetainPayload(smuggled)) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(
      ["bundlePath", "exitClassification", "harvestedCount", "repoSlug", "requestId", "runId", "spendMicroUsd"],
    );
    expect(parsed.boxProse).toBeUndefined();
    // Optional fields absent → absent from the payload, never null-filled.
    const minimal = JSON.parse(
      buildRetainPayload(
        outcome({
          harvestedCount: undefined,
          spendMicroUsd: undefined,
          bundlePath: undefined,
        }),
      ),
    ) as Record<string, unknown>;
    expect(Object.keys(minimal).sort()).toEqual(["exitClassification", "repoSlug", "requestId", "runId"]);
    // The classification is a closed union — free text is refused at the boundary.
    let thrown: unknown;
    try {
      buildRetainPayload(outcome({ exitClassification: "the agent seemed happy with the result" as never }));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(RunRetainError);
    expect((thrown as RunRetainError).code).toBe("retain-payload-invalid");
  });

  test("deriveDocumentId refuses malformed runIds — no time-based or random documentId is possible", () => {
    for (const bad of [
      "",
      "run-1",
      "qds-2026106-ab12cd", // 7-digit date
      "qds-20261006-AB12CD", // uppercase hex
      "qds-20261006-ab12cd-extra",
      "qds-20261006", // no suffix
      "abc-20261006-ab12cd", // wrong brand
      "qds-20261006-ab12c", // 5 hex
    ]) {
      let thrown: unknown;
      try {
        deriveDocumentId(bad);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(RunRetainError);
      expect((thrown as RunRetainError).code).toBe("retain-run-id-invalid");
    }
  });

  test("deriveDocumentId refuses a NON-STRING runId with the typed error, not a TypeError [F18]", () => {
    // The message stringifies the offending value safely (String(runId).slice),
    // so the typed retain-run-id-invalid surfaces even when the caller passes a
    // non-string (the old code called .slice on the raw value and died with an
    // untyped TypeError before the refusal could).
    let thrown: unknown;
    try {
      deriveDocumentId(123 as never);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(RunRetainError);
    expect((thrown as RunRetainError).code).toBe("retain-run-id-invalid");
    expect((thrown as RunRetainError).message).toContain("123");
  });

  test("repoSlug and requestId are bounded identity, never prose channels — refused pre-network [G14]", () => {
    const { calls, client } = fakeClient();
    for (const bad of [
      runInput({ repoSlug: "a".repeat(201) }), // one char past the 200 bound
      runInput({ repoSlug: "acme/widgets\u0000evil" }), // control character
      runInput({ requestId: "a".repeat(65) }), // one char past the 64 bound
      runInput({ requestId: "-leading-dash" }), // must start with [A-Za-z0-9]
      runInput({ requestId: "req..retain" }), // no '..' path-ellipsis channel
      runInput({ requestId: "req retain" }), // space is outside the class
      runInput({ requestId: "req/retain" }), // slash is outside the class
    ]) {
      let thrown: unknown;
      try {
        buildRetainPayload(bad);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(RunRetainError);
      expect((thrown as RunRetainError).code).toBe("retain-payload-invalid");
    }
    // Both refuse inside the builder — the fake client's retain is never reached.
    expect(calls.length).toBe(0);
    return expect(
      retainRunOutcome(client, undefined, runInput({ requestId: "bad id" })),
    ).rejects.toBeInstanceOf(RunRetainError);
  });

  test("bundlePath, when present, must be a bounded printable string — refused pre-network [F8]", () => {
    const { calls, client } = fakeClient();
    const oversize = runInput({ bundlePath: "a".repeat(513) }); // one char past the bound
    const controlChar = runInput({ bundlePath: ".sandbox/bundles/\u0000evil.tar.zst" });
    for (const bad of [oversize, controlChar]) {
      let thrown: unknown;
      try {
        buildRetainPayload(bad);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(RunRetainError);
      expect((thrown as RunRetainError).code).toBe("retain-payload-invalid");
      expect((thrown as RunRetainError).message).toContain("bundlePath");
    }
    // Both refuse inside the builder — the fake client's retain is never reached.
    expect(calls.length).toBe(0);
    return expect(retainRunOutcome(client, undefined, oversize)).rejects.toBeInstanceOf(RunRetainError);
  });

  test("no per-run credential parameter exists on the surface (INV-KG-2)", async () => {
    // The input surface is the closed RunRetainInput shape — no apiKey, no
    // token, no memory key slot exists for a caller to fill.
    const input = runInput();
    expect(Object.keys(input).sort()).toEqual(
      ["bundlePath", "exitClassification", "harvestedCount", "repoBankId", "repoSlug", "requestId", "runId", "spendMicroUsd", "tags"],
    );
    // And the wire extension this module sends carries identity + classification
    // only — never a credential field.
    const { calls, client } = fakeClient();
    await retainRunOutcome(client, undefined, input);
    const sent = calls[0];
    if (!sent) throw new Error("expected the retain call to be captured");
    expect(Object.keys(sent.metadata as object).sort()).toEqual(
      ["documentId", "kind", "source", "tags", "updateMode"],
    );
    const flat = JSON.stringify(sent);
    for (const forbidden of ["apiKey", "token", "credential", "password", "secret"]) {
      expect(flat.includes(forbidden)).toBe(false);
    }
  });
});
