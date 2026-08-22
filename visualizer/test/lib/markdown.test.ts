/**
 * DF4.2 unit tests for src/lib/markdown.ts (AC1).
 *
 * Pure string → string, no DOM required. Every supported construct listed in
 * the module's own doc comment gets a case, plus the safety model (all input
 * HTML-escaped before any tag is produced).
 */
import { describe, expect, test } from "bun:test";
import { renderMarkdown } from "../../src/lib/markdown.ts";

describe("renderMarkdown", () => {
  test("headings h1-h4", () => {
    expect(renderMarkdown("# a")).toBe("<h1>a</h1>");
    expect(renderMarkdown("## a")).toBe("<h2>a</h2>");
    expect(renderMarkdown("### a")).toBe("<h3>a</h3>");
    expect(renderMarkdown("#### a")).toBe("<h4>a</h4>");
  });

  test("a plain paragraph", () => {
    expect(renderMarkdown("hello world")).toBe("<p>hello world</p>");
  });

  test("bold text inside a paragraph", () => {
    expect(renderMarkdown("**bold**")).toBe("<p><strong>bold</strong></p>");
  });

  test("a link, restricted to http(s), opens in a new tab safely", () => {
    const out = renderMarkdown("[text](https://example.com)");
    expect(out).toBe(
      '<p><a href="https://example.com" target="_blank" rel="noopener noreferrer">text</a></p>',
    );
  });

  test("a non-http(s) link target is left as literal escaped text, not turned into a link", () => {
    const out = renderMarkdown("[text](javascript:alert(1))");
    expect(out).not.toContain("<a ");
  });

  test("inline code is not touched by bold/link parsing inside it", () => {
    const out = renderMarkdown("`**not bold**`");
    expect(out).toBe("<p><code>**not bold**</code></p>");
  });

  test("unordered list", () => {
    expect(renderMarkdown("- one\n- two")).toBe("<ul><li>one</li><li>two</li></ul>");
    expect(renderMarkdown("* one\n* two")).toBe("<ul><li>one</li><li>two</li></ul>");
  });

  test("ordered list", () => {
    expect(renderMarkdown("1. one\n2. two")).toBe("<ol><li>one</li><li>two</li></ol>");
  });

  test("blockquote, multi-line", () => {
    expect(renderMarkdown("> line one\n> line two")).toBe(
      "<blockquote>line one\nline two</blockquote>",
    );
  });

  test("horizontal rule, both dash and asterisk forms", () => {
    expect(renderMarkdown("---")).toBe("<hr>");
    expect(renderMarkdown("***")).toBe("<hr>");
  });

  test("plain fenced code block is escaped verbatim, not markdown-parsed", () => {
    const out = renderMarkdown("```\n**not bold**\n```");
    expect(out).toBe('<pre class="md-code"><code>**not bold**</code></pre>');
  });

  test("json-fenced code block is syntax highlighted", () => {
    const out = renderMarkdown('```json\n{"a":1}\n```');
    expect(out).toContain('<span class="j-key">&quot;a&quot;</span>');
    expect(out).toContain('<span class="j-num">1</span>');
  });

  test("an unterminated fence still closes the code block at EOF", () => {
    const out = renderMarkdown("```\nno closing fence");
    expect(out).toBe('<pre class="md-code"><code>no closing fence</code></pre>');
  });

  test("blank lines separate paragraphs and are dropped", () => {
    const out = renderMarkdown("first\n\nsecond");
    expect(out).toBe("<p>first</p>\n<p>second</p>");
  });

  test("a multi-line paragraph joins lines with a literal newline (pre-wrap in CSS)", () => {
    expect(renderMarkdown("line one\nline two")).toBe("<p>line one\nline two</p>");
  });

  test("all input is HTML-escaped before any tag is produced", () => {
    const out = renderMarkdown("<script>alert(1)</script>");
    expect(out).not.toContain("<script>");
    expect(out).toContain("&lt;script&gt;");
  });

  test("CRLF line endings are normalized before parsing", () => {
    expect(renderMarkdown("# a\r\n\r\nbody")).toBe("<h1>a</h1>\n<p>body</p>");
  });

  test("empty input renders nothing", () => {
    expect(renderMarkdown("")).toBe("");
  });
});
