/**
 * A2 leaf-1.3.1 — the qaWorkKey stamp + qaVerdict block (adds-only seams).
 *
 * Round-trip, `w:`-form validation at the WRITER seam, replay idempotence,
 * and the verdict fold into `ResultPayload` with `RESULT_SCHEMA_VERSION`
 * still the literal 1 and extras tolerated through.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildResult, RESULT_SCHEMA_VERSION } from "../../src/fleet/result.ts";
import {
  EXTENSION_NAMESPACES,
  QaVerdictError,
  QaWorkKeyError,
  RunRecordStore,
  qaVerdictPatch,
  qaWorkKeyPatch,
  readQaVerdict,
  readQaWorkKey,
} from "../../src/providers/run-record.ts";

let dir: string;
let store: RunRecordStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qds-qa-wk-"));
  store = new RunRecordStore({ dir });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("qaWorkKey namespace", () => {
  test("stamp + read round-trip through the store", () => {
    store.create("qds-20261016-qk001");
    const wk = "w:qa-20261016T120000Z-correctness";
    const rec = store.set("qds-20261016-qk001", qaWorkKeyPatch(wk));
    expect(rec.extensions?.qaWorkKey).toEqual({ schemaVersion: 1, workKey: wk });
    expect(readQaWorkKey(store.get("qds-20261016-qk001"))).toBe(wk);
  });

  test("the writer refuses a workKey outside the contract grammar with the named error", () => {
    expect(() => qaWorkKeyPatch("issue-7")).toThrow(QaWorkKeyError);
    expect(() => qaWorkKeyPatch("issue-7")).toThrow(/contract grammar/);
    expect(() => qaWorkKeyPatch("qa-7")).toThrow(QaWorkKeyError);
    expect(() => qaWorkKeyPatch("w:")).toThrow(QaWorkKeyError);
    // The bare `w:` namespace is no longer the pinned grammar: a key without
    // the `qa-` segment cannot be stamped through the writer seam.
    expect(() => qaWorkKeyPatch("w:zzz")).toThrow(QaWorkKeyError);
    expect(() => qaWorkKeyPatch("w:qa-")).toThrow(QaWorkKeyError);
    // Round-2: the CONTRACT grammar is `w:qa-<compact-UTC-stamp>-<lens>` — a
    // key with the right prefix but no stamp, a malformed stamp, or an empty
    // lens tail is refused at the writer, not canonized.
    expect(() => qaWorkKeyPatch("w:qa-leg-1")).toThrow(QaWorkKeyError);
    expect(() => qaWorkKeyPatch("w:qa-20261016T120000-correctness")).toThrow(QaWorkKeyError);
    expect(() => qaWorkKeyPatch("w:qa-20261016T120000Z-")).toThrow(QaWorkKeyError);
  });

  test("a replayed stamp is idempotent — same entry, same bytes of state", () => {
    store.create("qds-20261016-qk002");
    const wk = "w:qa-20261016T120001Z-correctness";
    const first = store.set("qds-20261016-qk002", qaWorkKeyPatch(wk));
    const replay = store.set("qds-20261016-qk002", qaWorkKeyPatch(wk));
    expect(replay.extensions?.qaWorkKey).toEqual(first.extensions?.qaWorkKey);
    expect(readQaWorkKey(store.get("qds-20261016-qk002"))).toBe(wk);
  });
});

describe("qaVerdict namespace + fold", () => {
  test("the namespace table pins both entries at schemaVersion 1", () => {
    expect(EXTENSION_NAMESPACES.qaWorkKey).toEqual({ schemaVersion: 1, fields: { workKey: "string" } });
    expect(EXTENSION_NAMESPACES.qaVerdict?.schemaVersion).toBe(1);
    expect(Object.keys(EXTENSION_NAMESPACES.qaVerdict?.fields ?? {})).toEqual([
      "status",
      "producedAt",
      "escalated",
      "qaRunId",
      "commitSha",
      "findingCount",
      "findingRefs",
    ]);
  });

  test("the record's verdict block folds into the payload; schemaVersion stays the literal 1", () => {
    store.create("qds-20261016-qk003");
    store.set("qds-20261016-qk003", {
      extensions: {
        qaVerdict: {
          status: "approved",
          producedAt: "2026-10-16T00:00:00.000Z",
          escalated: 1,
          qaRunId: "qds-20261016-qk003",
          commitSha: "a".repeat(40),
          findingCount: 3,
        },
      },
    });
    const rec = store.get("qds-20261016-qk003");
    expect(rec.extensions?.qaVerdict?.schemaVersion).toBe(1);
    expect(readQaVerdict(rec)?.status).toBe("approved");
    const payload = buildResult(store, "qds-20261016-qk003");
    expect(RESULT_SCHEMA_VERSION).toBe(1);
    expect(payload.schemaVersion).toBe(1);
    expect(payload.verdict).toEqual({
      status: "approved",
      producedAt: "2026-10-16T00:00:00.000Z",
      escalated: true,
      qaRunId: "qds-20261016-qk003",
      commitSha: "a".repeat(40),
      findingCount: 3,
    });
  });

  test("escalated 0 folds to false; extras pass through; schemaVersion stays off the wire", () => {
    // Extras are a READ-tolerant fact, not a write-mode one (write-exact
    // refuses an unregistered key): a newer writer's record carries the
    // extra, and this build reads and folds it verbatim — the same
    // read/write split `validateExtensions` makes.
    store.create("qds-20261016-qk004");
    writeFileSync(
      store.path("qds-20261016-qk004"),
      `${JSON.stringify(
        {
          runId: "qds-20261016-qk004",
          createdAt: "2026-10-16T00:00:00.000Z",
          extensions: {
            qaVerdict: {
              schemaVersion: 1,
              status: "approved",
              producedAt: "2026-10-16T00:00:00.000Z",
              escalated: 0,
              notes: "producer-side provenance extra",
            },
          },
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
    const payload = buildResult(store, "qds-20261016-qk004");
    expect(payload.verdict?.escalated).toBe(false);
    expect(payload.verdict?.notes).toBe("producer-side provenance extra");
    expect(Object.hasOwn(payload.verdict ?? {}, "schemaVersion")).toBe(false);
  });

  test("a record without the block carries NO verdict field; an unknown namespace still refuses", () => {
    store.create("qds-20261016-qk005");
    expect(buildResult(store, "qds-20261016-qk005").verdict).toBeUndefined();
    expect(() => store.set("qds-20261016-qk005", { extensions: { qaWorkKey: { workKey: "issue-7" } } })).not.toThrow();
    expect(() =>
      store.set("qds-20261016-qk005", { extensions: { qaNope: { workKey: "w:x" } } } as never),
    ).toThrow(/unregistered extension namespace/);
  });
});

describe("a2 review round 1 — fail-closed verdict seams", () => {
  // The verdict's qaRunId must be a MINTED id (qds-YYYYMMDD-hex6) under the
  // round-2 producer-schema parity, so these fixtures use hex tails even where
  // the record's own id does not.
  const baseVerdict = (qaRunId: string) => ({
    status: "approved",
    producedAt: "2026-10-16T00:00:00.000Z",
    qaRunId,
    commitSha: "a".repeat(40),
    findingCount: 0,
  });

  test("qaVerdictPatch round-trips a boolean escalated (true→fold true, false→fold false) and replays idempotent", () => {
    store.create("qds-20261016-qk006");
    store.set("qds-20261016-qk006", qaVerdictPatch({ ...baseVerdict("qds-20261016-abc006"), escalated: true }));
    store.set("qds-20261016-qk006", qaVerdictPatch({ ...baseVerdict("qds-20261016-abc006"), escalated: false }));
    // The stored field is the int the field table pins; the fold reads it back
    // as the boolean the consumer schema pins.
    expect(store.get("qds-20261016-qk006").extensions?.qaVerdict?.escalated).toBe(0);
    expect(buildResult(store, "qds-20261016-qk006").verdict?.escalated).toBe(false);
    // Replay (idempotent deep-merge, same as the workKey stamp).
    const replay = store.set(
      "qds-20261016-qk006",
      qaVerdictPatch({ ...baseVerdict("qds-20261016-abc006"), escalated: true }),
    );
    expect(replay.extensions?.qaVerdict).toEqual({
      schemaVersion: 1,
      ...baseVerdict("qds-20261016-abc006"),
      escalated: 1,
    });
    expect(buildResult(store, "qds-20261016-qk006").verdict?.escalated).toBe(true);
  });

  test("qaVerdictPatch validates its shape and carries findingRefs through the strings kind", () => {
    store.create("qds-20261016-qk007");
    expect(() => qaVerdictPatch({ ...baseVerdict("qds-20261016-abc007"), status: "" })).toThrow(QaVerdictError);
    expect(() => qaVerdictPatch({ ...baseVerdict("qds-20261016-abc007"), commitSha: "nothex" })).toThrow(QaVerdictError);
    expect(() => qaVerdictPatch({ ...baseVerdict("qds-20261016-abc007"), findingCount: -1 })).toThrow(QaVerdictError);
    expect(() => qaVerdictPatch({ ...baseVerdict("qds-20261016-abc007"), producedAt: "" })).toThrow(QaVerdictError);
    expect(() => qaVerdictPatch({ ...baseVerdict("qds-20261016-abc007"), qaRunId: "" })).toThrow(QaVerdictError);
    // Round-2: producer-schema parity is enforced at the writer — a non-vocab
    // status, a non-ISO producedAt (Date.parse alone accepts date-only), a
    // non-minted qaRunId and a MIXED-CASE sha are all refused here.
    expect(() => qaVerdictPatch({ ...baseVerdict("qds-20261016-abc007"), status: "failed" })).toThrow(QaVerdictError);
    expect(() => qaVerdictPatch({ ...baseVerdict("qds-20261016-abc007"), producedAt: "2026-10-16" })).toThrow(QaVerdictError);
    expect(() => qaVerdictPatch({ ...baseVerdict("qds-20261016-abc007"), qaRunId: "orphan-run" })).toThrow(QaVerdictError);
    expect(() => qaVerdictPatch({ ...baseVerdict("qds-20261016-abc007"), commitSha: "A".repeat(40) })).toThrow(QaVerdictError);
    store.set(
      "qds-20261016-qk007",
      qaVerdictPatch({ ...baseVerdict("qds-20261016-abc007"), findingCount: 2, findingRefs: ["doc-1", "doc-2"] }),
    );
    expect(store.get("qds-20261016-qk007").extensions?.qaVerdict?.findingRefs).toEqual(["doc-1", "doc-2"]);
    expect(buildResult(store, "qds-20261016-qk007").verdict?.findingRefs).toEqual(["doc-1", "doc-2"]);
  });

  test("a status-less block folds to NO verdict key — presence parity with readQaVerdict", () => {
    store.create("qds-20261016-qk008");
    // Write-mode legal (every key registered); the block simply has no status.
    store.set("qds-20261016-qk008", { extensions: { qaVerdict: { qaRunId: "orphan-run" } } });
    expect(readQaVerdict(store.get("qds-20261016-qk008"))).toBeUndefined();
    const payload = buildResult(store, "qds-20261016-qk008");
    expect(Object.hasOwn(payload, "verdict")).toBe(false);
    expect(payload.verdict).toBeUndefined();
  });

  test("a null qaVerdict entry crashes NEITHER seam", () => {
    // The store itself refuses a null namespace body ("must be an object"),
    // but consumers read records that did not come from this build's store —
    // the seams guard against the null regardless.
    const rec = {
      runId: "qds-20261016-qk009",
      createdAt: "2026-10-16T00:00:00.000Z",
      extensions: { qaVerdict: null },
    };
    expect(readQaVerdict(rec as never)).toBeUndefined();
    const payload = buildResult({ dir, get: () => rec } as never, rec.runId);
    expect(Object.hasOwn(payload, "verdict")).toBe(false);
  });

  test("escalated stays fail-closed: a read-tolerated string or object extra folds to TRUE", () => {
    for (const [i, escalated] of (["yes", {}] as unknown[]).entries()) {
      const id = `qds-20261016-qk01${i}`;
      store.create(id);
      writeFileSync(
        store.path(id),
        `${JSON.stringify({
          runId: id,
          createdAt: "2026-10-16T00:00:00.000Z",
          extensions: {
            qaVerdict: {
              schemaVersion: 1,
              status: "approved",
              producedAt: "2026-10-16T00:00:00.000Z",
              escalated,
            },
          },
        })}\n`,
        { mode: 0o600 },
      );
      expect(buildResult(store, id).verdict?.escalated).toBe(true);
    }
  });
});
