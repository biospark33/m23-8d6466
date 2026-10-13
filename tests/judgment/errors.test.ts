import { describe, expect, test } from "bun:test";
import { bodySnippet } from "../../src/judgment/errors.ts";

// The seam constructs its typed refusal from an arbitrary adapter body;
// building the diagnostic snippet must never throw first (AC-1: garbage in,
// typed JudgmentSchemaError out — never a bare TypeError).
describe("bodySnippet — the typed refusal's bodyText can never throw", () => {
  test("undefined body (stringify → undefined) falls back to its string form", () => {
    expect(bodySnippet(undefined)).toBe("undefined");
  });

  test("symbol body (stringify → undefined) stringifies via String()", () => {
    expect(bodySnippet(Symbol("jev"))).toBe("Symbol(jev)");
  });

  test("BigInt body (stringify throws) returns a bounded marker", () => {
    expect(bodySnippet(1n)).toBe("<unserializable bigint>");
  });

  test("cyclic body (stringify throws) returns a bounded marker", () => {
    const cyclic: unknown[] = [];
    cyclic.push(cyclic);
    expect(bodySnippet(cyclic)).toBe("<unserializable object>");
  });

  test("serializable body is its JSON text, truncated to 512 chars", () => {
    const snippet = bodySnippet({ model: "jev-1.13.0", pad: "x".repeat(1000) });
    expect(snippet.length).toBe(512);
    expect(snippet.startsWith('{"model":"jev-1.13.0"')).toBe(true);
  });
});
