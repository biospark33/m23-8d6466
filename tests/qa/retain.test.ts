/**
 * A2 AC3 (leaf-1.2.1) — qa-retain: the M1.2 trio (documentId determinism /
 * replace-dedup / receipt-dedup + divergence tamper alarm) over the multi-
 * finding shape, plus the 4 KiB per-finding ceiling refusal, the no-credential-
 * surface assertion, the qa-findings-retained vocabulary line with absent-not-0
 * semantics, and the INV-A2-6 negative control (a non-qds bank id is refused).
 *
 * Fake client mirrors tests/hindsight/run-retain.test.ts; the store legs run
 * the real `openAuditStore` on a tmpdir DB, and every test points
 * `QDS_AUDIT_DB` inside its own tmpdir FIRST so an accidental default-path
 * open can never resolve at the repo root.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { canonicalJson, openAuditStore, sha256Hex, type AuditStoreWriter } from "../../src/audit/link-store.ts";
import type { HindsightClient } from "../../src/hindsight/client.ts";
import { provisionedRepoBankCandidates, safeRepoBaseCandidates } from "../../src/hindsight/bank-provisioner.ts";
import { resolveBankId } from "../../src/hindsight/schemas.ts";
import { RETAIN_PAYLOAD_MAX_BYTES } from "../../src/hindsight/run-retain.ts";
import { setLogSink, type LogEntry } from "../../src/lib/log.ts";
import { FindingSchema, MAX_FINDINGS_PER_HARVEST, QA_LOG, type Finding } from "../../src/qa/findings.ts";
import {
  QaRetainError,
  deriveFindingDocumentId,
  retainFindings,
  type RetainFindingsInput,
} from "../../src/qa/retain.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let dir: string;
let prevAuditEnv: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qds-a2-qa-retain-"));
  prevAuditEnv = process.env.QDS_AUDIT_DB;
  process.env.QDS_AUDIT_DB = join(dir, "env-default-guard.db");
});

afterEach(() => {
  // biome-ignore lint/performance/noDelete: unsetting env vars requires delete
  if (prevAuditEnv === undefined) delete process.env.QDS_AUDIT_DB;
  else process.env.QDS_AUDIT_DB = prevAuditEnv;
  rmSync(dir, { recursive: true, force: true });
});

const RUN_ID = "qds-20261016-ab12cd";
const COMMIT = `${"a".repeat(39)}0`;
// The positive identity IS the slug-resolved provisioned family: the same
// candidate resolveProvisionedRepoBankId returns and the dispatch recall
// reads. A hand-named `qds-` bank is NOT this family (seam gap #11).
const BANK = "acme-widgets";

function finding(text: string, ref = "src/lib/log.ts:35"): Finding {
  return { runId: RUN_ID, lens: "correctness", finding_text: text, diff_context_ref: ref };
}

function input(over: Partial<RetainFindingsInput> = {}): RetainFindingsInput {
  return {
    repoBankId: BANK,
    runId: RUN_ID,
    lens: "correctness",
    commitSha: COMMIT,
    repoSlug: "acme/widgets",
    requestId: "req-qa-retain-1",
    legRan: true,
    findings: [finding("off-by-one in the retry loop"), finding("unbounded loop over ledger rows")],
    ...over,
  };
}

type RetainMetadata = Parameters<HindsightClient["retain"]>[2];

interface CapturedRetain {
  bankId: string;
  content: string;
  metadata?: RetainMetadata;
}

/**
 * Fake client: captures every retain call AND models the substrate's
 * document_id upsert (a Map keyed by documentId), so the replace-dedup trio
 * leg is observable as map size, not call count.
 */
function fakeClient() {
  const calls: CapturedRetain[] = [];
  const documents = new Map<string, string>();
  const client = {
    retain: async (bankId: string, content: string, metadata?: RetainMetadata) => {
      calls.push({ bankId, content, metadata });
      const documentId = metadata?.documentId;
      if (typeof documentId === "string") documents.set(documentId, content);
      return { memoryId: "", bankId, status: "created" as const, durationMs: 0 };
    },
  };
  return { calls, documents, client: client as unknown as Pick<HindsightClient, "retain"> };
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
// M1.2 trio
// ---------------------------------------------------------------------------

describe("qa retain M1.2 trio", () => {
  test("documentId determinism — same input twice yields the same ids, in the minted shape", async () => {
    const i = input();
    expect(deriveFindingDocumentId(i.runId, i.lens, 0)).toMatch(/^qds-\d{8}-[a-f0-9]{6}$/);
    // No clock, no randomness: the derivation is a pure function of
    // (runId, lens, index), so the same call derives the same id forever.
    expect(deriveFindingDocumentId(i.runId, i.lens, 0)).toBe(deriveFindingDocumentId(i.runId, i.lens, 0));
    expect(deriveFindingDocumentId(i.runId, "secret-hygiene", 0)).not.toBe(deriveFindingDocumentId(i.runId, i.lens, 0));
    expect(deriveFindingDocumentId(i.runId, i.lens, 0)).not.toBe(deriveFindingDocumentId(i.runId, i.lens, 1));
    // End-to-end: a byte-identical replay captures the SAME identity twice.
    const first = await retainFindings({ client: fakeClient().client }, i);
    const second = await retainFindings({ client: fakeClient().client }, i);
    expect(second.documentIds).toEqual(first.documentIds);
  });

  test("replace-dedup — replay leaves ONE document per finding, not two", async () => {
    const { calls, documents, client } = fakeClient();
    const i = input();
    await retainFindings({ client }, i);
    await retainFindings({ client }, i);
    // Four wire calls (2 findings x 2 retains), but the substrate's
    // document_id upsert collapses the replay: the map holds exactly one
    // entry per finding.
    expect(calls.length).toBe(4);
    expect(documents.size).toBe(2);
    // The replay's FIRST call (index 2) repeats the original FIRST call
    // (index 0): same documentId, same payload, same replace mode + tags + kind.
    const firstCall = calls[0];
    const secondCall = calls[2];
    if (!firstCall || !secondCall) throw new Error("expected both retains to be captured");
    // The wire saw the SAME identity twice: same documentId, same payload,
    // same replace mode + tags + kind.
    expect(secondCall).toEqual(firstCall);
    expect(firstCall.bankId).toBe(BANK);
    expect(firstCall.metadata).toEqual({
      documentId: deriveFindingDocumentId(RUN_ID, "correctness", 0),
      updateMode: "replace",
      tags: ["qa-f3", RUN_ID, "correctness"],
      kind: "observation",
      source: "agent",
    });
  });

  test("receipt dedup + divergence tamper alarm — replay leaves one row per finding; divergent content under the same id fires the alarm", async () => {
    const p = join(dir, "receipt.db");
    const store = openAuditStore(p);
    try {
      const { calls, client } = fakeClient();
      const i = input();
      await retainFindings({ client, auditStore: store }, i);
      await retainFindings({ client, auditStore: store }, i);
      const rows = storedRows(p);
      expect(rows.length).toBe(2);
      for (const row of rows) {
        expect(row.hop).toBe("memory-retain-receipt");
        expect(row.event).toBe("retain");
        expect(row.subject_kind).toBe("document");
        expect(JSON.parse(row.detail_json as string)).toEqual({ documentId: row.subject_id, bank: BANK });
      }
      const originalContent = calls[0]?.content;
      if (typeof originalContent !== "string") throw new Error("expected the first retain payload to be captured");
      const { lines, restore } = captureLog();
      try {
        // Same (runId, lens, index) identity, DIFFERENT content — exactly the
        // anomaly the store's divergent-evidence check exists to surface
        // (INV-KG-4): the store keeps the FIRST row and logs the divergence.
        const divergentInput = input({
          findings: [finding("off-by-one in the retry loop (edited)"), ...i.findings.slice(1)],
        });
        await retainFindings({ client, auditStore: store }, divergentInput);
        const after = storedRows(p);
        // Still 2 rows: the store is append-only — the divergent emit under
        // the existing subject id was DROPPED (never inserted), and index 1's
        // byte-identical receipt dedups. The alarm line is the only trace.
        expect(after.length).toBe(2);
        const editedId = deriveFindingDocumentId(RUN_ID, "correctness", 0);
        const standing = after.find((r) => r.subject_id === editedId);
        if (standing === undefined) throw new Error("expected the edited subject's row to stand");
        // The FIRST receipt row stands — the divergent emit was dropped.
        expect(standing.evidence_digest).toBe(identityDigest(BANK, editedId, sha256Hex(originalContent)));
        const divergent = lines.filter(
          (l) => l.operation === "audit-link.record" && l.status === "error" && l.outcome === "divergent",
        );
        expect(divergent.length).toBe(1);
      } finally {
        restore();
      }
    } finally {
      store.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Ceilings, surfaces, vocabulary, negative controls
// ---------------------------------------------------------------------------

describe("qa retain refusals and surfaces", () => {
  test("4 KiB per-finding ceiling is refused pre-network, never truncated", async () => {
    const { calls, client } = fakeClient();
    // Redaction runs BEFORE the ceiling, so the oversize fixture must be prose
    // that survives redaction (short words, no 40+-char token runs) — a
    // "x".repeat blob would collapse to «redacted» and land under the bound.
    const oversize = input({
      findings: [finding("a ".repeat(RETAIN_PAYLOAD_MAX_BYTES / 2))],
    });
    // An async refusal surfaces as a rejection, never a synchronous throw.
    await expect(retainFindings({ client }, oversize)).rejects.toBeInstanceOf(QaRetainError);
    await expect(retainFindings({ client }, oversize)).rejects.toMatchObject({ code: "retain-payload-oversize" });
    // Refused inside the builder — the fake client's retain is never reached.
    expect(calls.length).toBe(0);
  });

  test("secret material in finding_text is retained REDACTED — the sole prose channel never carries a live token", async () => {
    const secret = "sk-test0123456789abcdef";
    const { calls, client } = fakeClient();
    await retainFindings({ client }, input({ findings: [finding(`leaked ${secret} in the retry loop`)] }));
    const sent = calls[0];
    if (!sent) throw new Error("expected the retain call to be captured");
    // The STORED payload (what the substrate upserted) no longer carries the
    // raw token; the redaction marker stands in its place.
    expect(sent.content).not.toContain(secret);
    expect(sent.content).toContain("«redacted»");
  });

  test("redacted prose does not trip the ceiling — 4000 chars of repeated fake token retains, redacted, under 4 KiB", async () => {
    const { calls, client } = fakeClient();
    const token = "sk-test0123456789abcdef ";
    const text = token.repeat(170); // 4080 chars, under FindingSchema's 4096 bound
    expect(text.length).toBe(4080);
    const result = await retainFindings({ client }, input({ findings: [finding(text)] }));
    // Redaction collapsed every token to the marker, so the payload lands far
    // under the ceiling — the retain SUCCEEDS rather than being refused.
    expect(result.documentIds.length).toBe(1);
    const sent = calls[0];
    if (!sent) throw new Error("expected the retain call to be captured");
    expect(Buffer.byteLength(sent.content, "utf8")).toBeLessThanOrEqual(RETAIN_PAYLOAD_MAX_BYTES);
    expect(sent.content).not.toContain("sk-test0123456789abcdef");
  });

  test("a batch past the per-harvest cap is refused pre-network, never truncated", async () => {
    const { calls, client } = fakeClient();
    const oversized = input({
      findings: Array.from({ length: MAX_FINDINGS_PER_HARVEST + 1 }, (_, i) => finding(`finding ${i}`)),
    });
    await expect(retainFindings({ client }, oversized)).rejects.toMatchObject({ code: "retain-findings-overflow" });
    expect(calls.length).toBe(0);
  });

  test("a finding attributed to a foreign runId or lens is refused, never silently re-attributed", async () => {
    const { calls, client } = fakeClient();
    for (const [bad, code] of [
      [input({ findings: [finding("ok"), { ...finding("foreign run"), runId: "qds-20261016-ff00ff" }] }), "retain-attribution-mismatch"],
      [input({ findings: [{ ...finding("foreign lens"), lens: "secret-hygiene" }] }), "retain-attribution-mismatch"],
    ] as const) {
      await expect(retainFindings({ client }, bad)).rejects.toMatchObject({ code });
    }
    // The whole call refused before any retain landed.
    expect(calls.length).toBe(0);
  });

  test("partial failure: a rejecting 2nd finding keeps the landed 1st — resolve-not-reject, 1 doc + 1 receipt + 1 failure", async () => {
    const p = join(dir, "partial.db");
    const store = openAuditStore(p);
    try {
      const calls: CapturedRetain[] = [];
      const flaky = {
        retain: async (bankId: string, content: string, metadata?: RetainMetadata) => {
          if (calls.length === 1) throw new Error("second retain exploded");
          calls.push({ bankId, content, metadata });
          return { memoryId: "", bankId, status: "created" as const, durationMs: 0 };
        },
      } as unknown as Pick<HindsightClient, "retain">;
      const result = await retainFindings({ client: flaky, auditStore: store }, input());
      // Resolved, not rejected: the landed finding survives.
      expect(result.retained).toBe(true);
      expect(result.documentIds).toEqual([deriveFindingDocumentId(RUN_ID, "correctness", 0)]);
      const failures = result.failures;
      if (!failures) throw new Error("expected the failure to be recorded");
      expect(failures.length).toBe(1);
      expect(failures[0]?.documentId).toBe(deriveFindingDocumentId(RUN_ID, "correctness", 1));
      expect(typeof failures[0]?.error).toBe("string"); // redacted + bounded, never a raw error object
      // Only the landed doc's receipt exists.
      const rows = storedRows(p);
      expect(rows.length).toBe(1);
      expect(rows[0]?.subject_id).toBe(deriveFindingDocumentId(RUN_ID, "correctness", 0));
      // All-landed contrast: the failures key is ABSENT (absent-not-0).
      const ok = await retainFindings({ client: fakeClient().client }, input());
      expect("failures" in ok).toBe(false);
    } finally {
      store.close();
    }
  });

  test("nothing landed (every retain rejects) is the only rejecting path", async () => {
    const { lines, restore } = captureLog();
    try {
      const dead = {
        retain: async () => {
          throw new Error("substrate down");
        },
      } as unknown as Pick<HindsightClient, "retain">;
      await expect(retainFindings({ client: dead }, input())).rejects.toMatchObject({ code: "retain-none-landed" });
      // Nothing landed → no vocabulary line, no receipts.
      expect(lines.find((l) => l.operation === QA_LOG.findingsRetained)).toBeUndefined();
    } finally {
      restore();
    }
  });

  test("no credential parameter exists on any surface (INV-KG-2 / INV-A2-2)", async () => {
    const i = input();
    // The input surface is the closed RetainFindingsInput shape — no apiKey,
    // no token, no memory-key slot exists for a caller to fill; deps carry
    // exactly the client (which itself holds the host env token) and the
    // optional audit store.
    expect(Object.keys(i).sort()).toEqual(
      ["commitSha", "findings", "legRan", "lens", "repoBankId", "repoSlug", "requestId", "runId"],
    );
    const { calls, client } = fakeClient();
    await retainFindings({ client }, i);
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

  test("qa-findings-retained vocabulary line: bankId + documentIds, [] only for ran-and-none, ABSENT for a refused non-ran leg", async () => {
    const { lines, restore } = captureLog();
    try {
      const { client } = fakeClient();
      // Two findings → two ids, explicitly present.
      const result = await retainFindings({ client }, input());
      const line = lines.find((l) => l.operation === QA_LOG.findingsRetained);
      expect(line).toBeDefined();
      expect(line).toMatchObject({ bankId: BANK, documentIds: result.documentIds, status: "ok" });
      expect(result.documentIds.length).toBe(2);
      // Ran-and-none → documentIds is [] PRESENT (absent-not-0 law), and the
      // retain wire is never touched.
      const { client: zeroClient } = fakeClient();
      lines.length = 0;
      const zero = await retainFindings({ client: zeroClient }, input({ findings: [] }));
      const zeroLine = lines.find((l) => l.operation === QA_LOG.findingsRetained);
      expect(zeroLine).toBeDefined();
      expect(zeroLine?.documentIds).toEqual([]);
      expect(zero.documentIds).toEqual([]);
      // A non-ran leg is refused BEFORE any log line or retain exists —
      // documentIds is neither [] nor 0, it is ABSENT because the call refused.
      lines.length = 0;
      const refused = input({ legRan: false, findings: [] });
      let thrown: unknown;
      try {
        await retainFindings({ client: zeroClient }, refused);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(QaRetainError);
      expect((thrown as QaRetainError).code).toBe("retain-leg-not-ran");
      expect(lines.find((l) => l.operation === QA_LOG.findingsRetained)).toBeUndefined();
    } finally {
      restore();
    }
  });

  test("AC3 negative control: a retain targeting a NON-repo bank (solstice-* family, a foreign qds-* hand-named bank, or non-schema id) is refused by the repo-bank guard (INV-A2-6)", async () => {
    const { calls, client } = fakeClient();
    // "qds-acme-widgets" is the legacy hand-named spelling: BankIdSchema-valid,
    // qds-prefixed, and still FOREIGN to acme/widgets' resolved family — the
    // exact seam-gap-#11 confusion, now refused from the other side.
    for (const badBank of ["solstice-collective", "solstice-acme-widgets", "qds-acme-widgets", "qds-somewhere-else", "other-widgets", "qds", ""]) {
      let thrown: unknown;
      try {
        await retainFindings({ client }, input({ repoBankId: badBank }));
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(QaRetainError);
      expect((thrown as QaRetainError).code).toBe("retain-bank-not-repo");
    }
    // Every refusal fired inside the guard — the wire was never reached.
    expect(calls.length).toBe(0);
  });

  test("family-resolved bank id is accepted (INV-A2-6): the base, a -N sibling, and both truncation-era base forms of the repo's own family pass the guard", async () => {
    const { calls, client } = fakeClient();
    // The resolved base and a disambiguation sibling are both in-family.
    await retainFindings({ client }, input({ repoBankId: "acme-widgets" }));
    await retainFindings({ client }, input({ repoBankId: "acme-widgets-3" }));
    // A slug long enough to split the truncation eras: both safe base forms
    // (current 50-max and legacy 52-max) are the SAME family to the guard.
    const longSlug = "acme/quds-factory-with-a-sufficiently-long-repository-name-exceeding-fifty";
    const longBase = resolveBankId(longSlug);
    expect(longBase.length).toBeGreaterThan(50);
    const [current, legacy] = safeRepoBaseCandidates(longBase);
    expect(legacy).not.toBe(current);
    await retainFindings({ client }, input({ repoSlug: longSlug, repoBankId: current! }));
    await retainFindings({ client }, input({ repoSlug: longSlug, repoBankId: `${legacy}-2` }));
    // The negative control's complement: the candidate set is exactly the
    // resolver's enumeration — 2 base forms x (1 base + 10 suffixes).
    expect(provisionedRepoBankCandidates(longBase).length).toBe(22);
    // All four in-family banks took the wire (two findings per retain).
    expect(new Set(calls.map((c) => c.bankId)).size).toBe(4);
  });

  test("a non-string repoSlug is refused by the slug guard before the bank guard resolves it (no TypeError leak)", async () => {
    const { client } = fakeClient();
    let thrown: unknown;
    try {
      await retainFindings({ client }, input({ repoSlug: undefined as unknown as string }));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(QaRetainError);
    expect((thrown as QaRetainError).code).toBe("retain-payload-invalid");
  });

  test("malformed identity and findings are refused with named codes, pre-network", async () => {
    const { calls, client } = fakeClient();
    for (const [bad, code] of [
      [input({ runId: "run-1" }), "retain-run-id-invalid"],
      [input({ runId: "qds-2026106-ab12cd" }), "retain-run-id-invalid"],
      [input({ lens: "vibes" }), "retain-payload-invalid"],
      [input({ commitSha: "not-a-sha" }), "retain-payload-invalid"],
      [input({ requestId: "bad id" }), "retain-payload-invalid"],
      [input({ repoSlug: "a".repeat(201) }), "retain-payload-invalid"],
      [input({ findings: [null as unknown as Finding] }), "retain-payload-invalid"],
      [input({ findings: ["x" as unknown as Finding] }), "retain-payload-invalid"],
      [input({ findings: [finding("ok"), { runId: RUN_ID, lens: "correctness", finding_text: "", diff_context_ref: "x.ts" } as Finding] }), "retain-payload-invalid"],
    ] as const) {
      await expect(retainFindings({ client }, bad)).rejects.toMatchObject({ code });
    }
    // A malformed finding anywhere refuses the WHOLE call before any retain
    // lands — the payloads are all built and bounded first.
    expect(calls.length).toBe(0);
  });

  test("best-effort receipt: a refusing store never fails the landed retains — refusal logged", async () => {
    const refusing: AuditStoreWriter = {
      path: join(dir, "refusing.db"),
      record() {
        throw new QaRetainError("retain-payload-invalid", "audit-link-invalid: refused by the test store");
      },
      close() {},
    };
    const { lines, restore } = captureLog();
    try {
      const { calls, client } = fakeClient();
      const result = await retainFindings({ client, auditStore: refusing }, input());
      // The retains landed; only the receipts were refused.
      expect(result.retained).toBe(true);
      expect(calls.length).toBe(2);
      const refusal = lines.find((l) => l.operation === "memory-retain-receipt" && l.status === "error");
      expect(refusal).toBeDefined();
      expect(refusal?.error?.message).toMatch(/refused by the test store/);
    } finally {
      restore();
    }
  });

  test("receipt-refusal message is stringified, redacted, bounded to 200", async () => {
    const secret = "sk-test0123456789abcdef";
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
      await retainFindings({ client, auditStore: refusing }, input());
      const refusal = lines.find((l) => l.operation === "memory-retain-receipt" && l.status === "error");
      expect(refusal).toBeDefined();
      const message = refusal?.error?.message;
      expect(typeof message).toBe("string");
      expect((message as string).length).toBe(200);
      expect(message).not.toContain(secret);
    } finally {
      restore();
    }
  });

  test("a throwing log sink never converts landed retains into a failure or drops the receipt rows", async () => {
    const restore = setLogSink(() => {
      throw new Error("sink exploded");
    });
    const p = join(dir, "throwing-sink.db");
    const store = openAuditStore(p);
    try {
      const { calls, client } = fakeClient();
      const result = await retainFindings({ client, auditStore: store }, input());
      expect(result.retained).toBe(true);
      expect(calls.length).toBe(2);
      expect(storedRows(p).length).toBe(2);
    } finally {
      restore();
      store.close();
    }
  });

  test("every retained document's payload is structured-only with the finding as the sole prose channel", async () => {
    const { calls, client } = fakeClient();
    await retainFindings({ client }, input());
    const sent = calls[0];
    if (!sent) throw new Error("expected the retain call to be captured");
    const i = input();
    const firstFinding = i.findings[0];
    if (!firstFinding) throw new Error("expected the fixture to carry a first finding");
    const parsed = JSON.parse(sent.content) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(["commitSha", "diff_context_ref", "finding_text", "lens", "runId"]);
    expect(parsed.finding_text).toBe(firstFinding.finding_text);
    // FindingSchema round-trips the retained prose — the payload IS the finding
    // plus provenance, nothing smuggled alongside.
    expect(parsed.commitSha).toBe(COMMIT);
    expect(FindingSchema.safeParse({ runId: parsed.runId, lens: parsed.lens, finding_text: parsed.finding_text, diff_context_ref: parsed.diff_context_ref }).success).toBe(true);
  });
});

// ─── the round correlation (round 19 attempt 12, live) ──────────────────────

describe("finding payload round correlation", () => {
  test("correlation rides the payload verbatim when present; absent stays absent", async () => {
    const { calls, client } = fakeClient();
    const withCorr = await retainFindings({ client }, input({ correlation: "acme/widgets w:z3-20261102T120000Z-code" }));
    expect(withCorr.documentIds).toHaveLength(2);
    const stored = JSON.parse(calls[0]?.content ?? "{}") as Record<string, unknown>;
    expect(stored.correlation).toBe("acme/widgets w:z3-20261102T120000Z-code");

    const { calls: calls2, client: client2 } = fakeClient();
    await retainFindings({ client: client2 }, input());
    const stored2 = JSON.parse(calls2[0]?.content ?? "{}") as Record<string, unknown>;
    expect(Object.hasOwn(stored2, "correlation")).toBeFalse();
  });
});
