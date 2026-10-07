/**
 * M1.2 AC3: the optional `kgContext` brief field — ceiling and charset
 * enforced at the schema (INV-KG-3), absent-field v5 identity.
 *
 * The number 8_000 is pinned LITERALLY, not imported: the test exists to fail
 * the day the schema's ceiling moves, and an exported constant the test reads
 * would make that day a quiet pass. Same reasoning as the schema's own refusal
 * to import the producer-side KG_CONTEXT_MAX_CHARS.
 */
import { describe, expect, test } from "bun:test";
import type { ZodError } from "zod";

import {
  BriefSchema,
  extractZodErrorField,
  kgContextIsWellFormed,
  kgContextSanitize,
} from "../../src/fleet/brief-schema.ts";

const BRIEF_KG_CONTEXT_MAX_CHARS = 8_000;

function validBrief(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    repoSlug: "owner/repo",
    issueId: 123,
    commitSha: "a".repeat(40),
    manifestPath: "path/to/pipeline.json",
    repoUrl: "https://github.com/owner/repo",
    ...over,
  };
}

/** The multi-line XML shape the producer (kg-context assembly) actually emits. */
function kgBlock(lines: readonly string[]): string {
  return ["<kg_context>", ...lines, "</kg_context>"].join("\n");
}

/**
 * Assert the refusal is kgContext's OWN rule, not the fixture failing on an
 * unrelated field — a bare .toThrow() cannot tell a charset refusal from a
 * brief that stopped being valid for some other reason.
 */
function expectKgContextRejected(brief: Record<string, unknown>): void {
  const result = BriefSchema.safeParse(brief);
  expect(result.success).toBe(false);
  const error = (result as { error: ZodError }).error;
  expect(extractZodErrorField(error)).toBe("kgContext");
}

describe("kgContext brief schema", () => {
  test("accepts an in-ceiling multi-line XML block, carried through verbatim", () => {
    const block = kgBlock([
      '\t<observation bank="qds-owner-repo" documentId="qds-20260920-abc123">',
      "Run qds-20260920-abc123 exited 0; review latency p95 6m [cite:1]",
      "\t</observation>",
    ]);
    const result = BriefSchema.safeParse(validBrief({ kgContext: block }));
    expect(result.success).toBe(true);
    expect((result as { data: { kgContext: string } }).data.kgContext).toBe(block);
  });

  test("refuses a value one char over the 8,000-char ceiling (never truncated)", () => {
    expectKgContextRejected(validBrief({ kgContext: "x".repeat(BRIEF_KG_CONTEXT_MAX_CHARS + 1) }));
  });

  test("accepts a value exactly at the ceiling", () => {
    const result = BriefSchema.safeParse(validBrief({ kgContext: "x".repeat(BRIEF_KG_CONTEXT_MAX_CHARS) }));
    expect(result.success).toBe(true);
  });

  test("refuses every control-char class except newline and tab", () => {
    // Each embedded mid-line in an otherwise-valid block: the block grammar is
    // no defense, and \r especially must die inside it, not at some fold later.
    // C1 is refused too — U+0085 (NEL) forges a line boundary for mainframe-
    // folding consumers — as are U+2028/U+2029, JS line terminators no `\n`
    // needed; DEL (\x7f) rides in the same Cc category.
    const refused = [
      "\x00",
      "\x01",
      "\x0b",
      "\x0c",
      "\x0e",
      "\x1f",
      "\x7f",
      "\r",
      "\u0085",
      "\u2028",
      "\u2029",
    ];
    for (const ch of refused) {
      expectKgContextRejected(validBrief({ kgContext: kgBlock([`line one${ch}line two`]) }));
    }
  });

  test("newline and tab are the payload, not an attack", () => {
    const result = BriefSchema.safeParse(
      validBrief({ kgContext: kgBlock(["\tindented line", "second line"]) }),
    );
    expect(result.success).toBe(true);
  });

  test("kgContextSanitize strips exactly the refused set and the result is well-formed", () => {
    // One of each refused class interleaved with keepers — Cc (NUL, DEL, C1's
    // NEL), \r, and the JS line terminators U+2028/U+2029 — against \t and
    // \n, which are the payload and must survive.
    const dirty = "a\x00b\x7fc\u0085d\re\u2028f\u2029g\th i\n";
    const clean = kgContextSanitize(dirty);
    expect(clean).toBe("abcdefg\th i\n");
    // Round-trip: what sanitize produces satisfies the schema's own predicate.
    expect(kgContextIsWellFormed(clean)).toBe(true);
    expect(kgContextIsWellFormed(dirty)).toBe(false);
    // An already-clean string is unchanged — the predicate's fixpoint.
    expect(kgContextSanitize(clean)).toBe(clean);
  });

  test("absent field: parse output is the v5 object exactly", () => {
    const without = BriefSchema.parse(validBrief());
    const withField = BriefSchema.parse(validBrief({ kgContext: kgBlock(["obs [cite:1]"]) }));
    expect("kgContext" in without).toBe(false);
    const { kgContext: _present, ...rest } = withField;
    expect(rest).toEqual(without);
    // Byte-level, not just deep-equal: JSON.stringify is what crosses the seam
    // into the shipped brief, so key ORDER is part of the v5 identity too.
    expect(JSON.stringify(rest)).toBe(JSON.stringify(without));
  });
});
