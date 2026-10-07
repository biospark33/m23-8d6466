/**
 * M1.2 AC3: `residentContextLines` renders the brief's `kgContext` verbatim as
 * its own trailing block when present (INV-KG-3 — the schema's ceiling and
 * control-char refine are the boundary guard; sanitizeForMessage would destroy
 * the multi-line XML), and produces byte-identical lines when absent.
 */
import { describe, expect, test } from "bun:test";

import { residentContextLines } from "../../scripts/pipeline-run.ts";
import type { PhaseSpec } from "../../src/phase-engine/index.ts";

const RUN_ID = "qds-20261006-test01";
const MANIFEST = {
  pipelineId: "test-pipeline",
  phases: [
    {
      name: "probe",
      kind: "code",
      description: "probe phase",
      maxDurationMs: 60_000,
      retries: 0,
    },
  ] as PhaseSpec[],
};

const BRIEF = { requestId: "req-1", repoSlug: "qds/demo", issueId: 42 };

const KG_BLOCK = [
  "<kg_context>",
  '\t<observation bank="qds-demo" documentId="qds-20260920-abc123">',
  "Run qds-20260920-abc123 exited 0 [cite:1]",
  "\t</observation>",
  "</kg_context>",
].join("\n");

describe("kgContext resident render", () => {
  test("present: the block is appended last, verbatim, after unchanged lines", () => {
    const without = residentContextLines(RUN_ID, MANIFEST, BRIEF);
    const withBlock = residentContextLines(RUN_ID, MANIFEST, { ...BRIEF, kgContext: KG_BLOCK });
    // The pre-existing lines are untouched — the append is ADDS-ONLY — and the
    // block line is byte-identical to the brief's value.
    expect(withBlock).toEqual([...without, KG_BLOCK]);
    expect(withBlock[withBlock.length - 1]).toBe(KG_BLOCK);
  });

  test("absent: the lines are exactly the pre-change render", () => {
    expect(residentContextLines(RUN_ID, MANIFEST, BRIEF)).toEqual([
      "pipeline test-pipeline run qds-20261006-test01",
      "requestId: req-1",
      "repoSlug: qds/demo",
      "issueId: 42",
      "phases: probe(code)",
    ]);
  });

  test("empty string and non-string kgContext render nothing", () => {
    // `""` is the one present-but-unusable value: falsy, so it must not push an
    // empty trailing line that a consumer counts as a block.
    const empty = residentContextLines(RUN_ID, MANIFEST, { ...BRIEF, kgContext: "" });
    expect(empty).toEqual(residentContextLines(RUN_ID, MANIFEST, BRIEF));
    const nonString = residentContextLines(RUN_ID, MANIFEST, { ...BRIEF, kgContext: 7 });
    expect(nonString).toEqual(residentContextLines(RUN_ID, MANIFEST, BRIEF));
  });
});
