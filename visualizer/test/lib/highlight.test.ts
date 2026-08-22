/**
 * DF4.2 unit tests for src/lib/highlight.ts (AC1).
 */
import { describe, expect, test } from "bun:test";
import { escapeHtml, highlightJsonText, highlightJson } from "../../src/lib/highlight.ts";

describe("escapeHtml", () => {
  test("escapes all five reserved characters", () => {
    expect(escapeHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
  });

  test("plain text passes through unchanged", () => {
    expect(escapeHtml("plain text")).toBe("plain text");
  });
});

describe("highlightJsonText", () => {
  test("wraps an object key in j-key, a string value in j-str", () => {
    const out = highlightJsonText('{"a": "b"}');
    expect(out).toContain('<span class="j-key">&quot;a&quot;</span>');
    expect(out).toContain('<span class="j-str">&quot;b&quot;</span>');
  });

  test("wraps booleans in j-bool and null in j-null", () => {
    const out = highlightJsonText("[true, false, null]");
    expect(out).toContain('<span class="j-bool">true</span>');
    expect(out).toContain('<span class="j-bool">false</span>');
    expect(out).toContain('<span class="j-null">null</span>');
  });

  test("wraps integers, negatives, decimals and exponents in j-num", () => {
    const out = highlightJsonText("[1, -2, 3.5, 1e10]");
    expect(out).toContain('<span class="j-num">1</span>');
    expect(out).toContain('<span class="j-num">-2</span>');
    expect(out).toContain('<span class="j-num">3.5</span>');
    expect(out).toContain('<span class="j-num">1e10</span>');
  });

  test("escapes non-token text between matches, including HTML metacharacters", () => {
    const out = highlightJsonText('<tag> "x"');
    expect(out).toContain("&lt;tag&gt;");
    expect(out).toContain('<span class="j-str">&quot;x&quot;</span>');
  });

  test("a string that itself contains an escaped quote is one token, not split", () => {
    const out = highlightJsonText('"a\\"b"');
    expect(out).toBe('<span class="j-str">&quot;a\\&quot;b&quot;</span>');
  });

  test("empty input → empty output", () => {
    expect(highlightJsonText("")).toBe("");
  });
});

describe("highlightJson", () => {
  test("no input → empty string", () => {
    expect(highlightJson(null)).toBe("");
    expect(highlightJson(undefined)).toBe("");
    expect(highlightJson("")).toBe("");
  });

  test("valid JSON is pretty-printed and highlighted", () => {
    const out = highlightJson('{"a":1}');
    expect(out).toContain('<span class="j-key">&quot;a&quot;</span>');
    expect(out).toContain('<span class="j-num">1</span>');
    // Pretty-printed with 2-space indent means a newline is present.
    expect(out).toContain("\n");
  });

  test("invalid JSON falls back to escaped raw text", () => {
    expect(highlightJson("<not json>")).toBe(escapeHtml("<not json>"));
  });
});
