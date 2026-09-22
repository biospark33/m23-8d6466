/**
 * Side-channel emit tests (JEV-2 AC-6, INV-J3).
 *
 * Layout: exactly one JSON file per requestId under the provenance dir
 * (tests ALWAYS override to a temp dir — never the real `_bmad-output`
 * path). `detail` is digest-stable: no answer values, no confidence.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DigestDivergenceError, emitProvenance, type ProvenanceDetail } from "../../src/judgment/emit.ts";

function detail(overrides: Partial<ProvenanceDetail> = {}): ProvenanceDetail {
  return {
    requestId: "rid-1",
    model: "jev-1.13.0",
    egressClass: "finding-text",
    questions: [{ id: "q1", type: "noul" }],
    usage: { input_tokens: 120, output_tokens: 8 },
    createdAt: "2026-09-22T00:00:00.000Z",
    ...overrides,
  };
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jev-emit-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("emitProvenance", () => {
  test("writes exactly one file keyed by requestId under the overridden dir", () => {
    const r = emitProvenance(detail(), dir);
    expect(r.wrote).toBe(true);
    expect(readdirSync(dir)).toEqual(["rid-1.json"]);
    const parsed = JSON.parse(readFileSync(join(dir, "rid-1.json"), "utf8"));
    expect(parsed.requestId).toBe("rid-1");
    expect(parsed.detail.model).toBe("jev-1.13.0");
    expect(parsed.detail.questions).toEqual([{ id: "q1", type: "noul" }]);
    expect(parsed.detail.usage).toEqual({ input_tokens: 120, output_tokens: 8 });
    expect(parsed.digest).toBe(r.digest);
  });

  test("detail carries NO volatile answer values or confidence (INV-J3)", () => {
    emitProvenance(detail(), dir);
    const parsed = JSON.parse(readFileSync(join(dir, "rid-1.json"), "utf8"));
    // The digest-stable field set is closed: question metadata (ids/types)
    // belongs, answer VALUES do not — so no answers/probabilities/confidence
    // key can ever appear, at any nesting depth.
    expect(Object.keys(parsed.detail).sort()).toEqual(
      ["createdAt", "egressClass", "model", "questions", "requestId", "usage"].sort(),
    );
    expect(readFileSync(join(dir, "rid-1.json"), "utf8")).not.toMatch(
      /answers|probabilities|confidence/,
    );
  });

  test("identical re-emit is a no-op (same digest)", () => {
    const d = detail();
    const first = emitProvenance(d, dir);
    const before = readFileSync(join(dir, "rid-1.json"), "utf8");
    const second = emitProvenance(d, dir);
    expect(second.wrote).toBe(false);
    expect(second.digest).toBe(first.digest);
    expect(readFileSync(join(dir, "rid-1.json"), "utf8")).toBe(before);
  });

  test("different digest for the same requestId throws DigestDivergenceError", () => {
    emitProvenance(detail(), dir);
    const divergent = detail({ usage: { input_tokens: 999, output_tokens: 8 } });
    let caught: DigestDivergenceError | undefined;
    try {
      emitProvenance(divergent, dir);
    } catch (e) {
      caught = e as DigestDivergenceError;
    }
    expect(caught).toBeInstanceOf(DigestDivergenceError);
    expect(caught?.requestId).toBe("rid-1");
    expect(caught?.message).toContain("rid-1");
  });

  test("different requestIds land as separate files", () => {
    emitProvenance(detail(), dir);
    emitProvenance(detail({ requestId: "rid-2" }), dir);
    expect(readdirSync(dir).sort()).toEqual(["rid-1.json", "rid-2.json"]);
  });
});
