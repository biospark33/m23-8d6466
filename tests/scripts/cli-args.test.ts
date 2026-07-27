/**
 * Unit tests for `scripts/lib/parseValueFlags` (issue #64).
 *
 * This helper has an explicit behavior contract written into its own docblock,
 * and three scripts depend on it. The tests below assert THAT CONTRACT clause by
 * clause rather than the implementation, so a rewrite that keeps the grammar
 * keeps the suite green — and the two places where the code and the docblock
 * disagree are pinned as such (see "documented contract vs actual behavior").
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as path from "node:path";

import { parseValueFlags, type ValueFlagSpec } from "../../scripts/lib/cli-args.ts";

const HELP = ["usage: thing --repo-slug <slug>", "  --repo-slug  the slug"];

/** Collects every `(flag, value)` pair the parser emits, in argv order. */
function collect(argv: readonly string[], flags: readonly string[] = ["--repo-slug", "--bank-id"]) {
  const seen: Array<[string, string]> = [];
  const spec: ValueFlagSpec = {
    flags,
    onValue: (f, v) => seen.push([f, v]),
    help: HELP,
  };
  parseValueFlags(argv, spec);
  return seen;
}

describe("parseValueFlags — `--flag=value` form", () => {
  test("a non-empty value is delivered to onValue", () => {
    expect(collect(["--repo-slug=owner/repo"])).toEqual([["--repo-slug", "owner/repo"]]);
  });

  test("an empty value is rejected, not silently accepted", () => {
    expect(() => collect(["--repo-slug="])).toThrow("--repo-slug requires a non-empty value");
  });

  test("the value may itself contain `=`", () => {
    expect(collect(["--repo-slug=a=b=c"])).toEqual([["--repo-slug", "a=b=c"]]);
  });

  test("a flag-looking value is allowed in this form (only the space form rejects it)", () => {
    expect(collect(["--repo-slug=--weird"])).toEqual([["--repo-slug", "--weird"]]);
  });

  test("an unknown flag throws and names itself", () => {
    expect(() => collect(["--repo=x"])).toThrow("unknown flag: --repo");
  });

  test("whitespace is a value — it is the caller's job to trim", () => {
    expect(collect(["--repo-slug= "])).toEqual([["--repo-slug", " "]]);
  });
});

describe("parseValueFlags — `--flag value` form", () => {
  test("the next argv element becomes the value", () => {
    expect(collect(["--repo-slug", "owner/repo"])).toEqual([["--repo-slug", "owner/repo"]]);
  });

  test("the value is consumed, not re-parsed as a token", () => {
    // Without the `++i` consume, "bank-1" would fall through as a bare token.
    expect(collect(["--repo-slug", "owner/repo", "--bank-id", "bank-1"])).toEqual([
      ["--repo-slug", "owner/repo"],
      ["--bank-id", "bank-1"],
    ]);
  });

  test("a trailing bare flag with no value throws rather than defaulting", () => {
    expect(() => collect(["--repo-slug"])).toThrow("--repo-slug requires a non-empty value");
  });

  test("an empty-string value throws", () => {
    expect(() => collect(["--repo-slug", ""])).toThrow("--repo-slug requires a non-empty value");
  });

  test("a flag-looking value throws instead of swallowing the next flag", () => {
    // The false-friendly reading: `--repo-slug --bank-id x` must NOT set
    // repo-slug to "--bank-id" and drop bank-id entirely.
    expect(() => collect(["--repo-slug", "--bank-id", "x"])).toThrow(
      "--repo-slug requires a non-empty value",
    );
  });

  test("a single-dash token IS accepted as a value (only `--` prefixes are rejected)", () => {
    expect(collect(["--repo-slug", "-h"])).toEqual([["--repo-slug", "-h"]]);
  });

  test("repeats are delivered in order — precedence is the caller's contract", () => {
    expect(collect(["--repo-slug", "a", "--repo-slug", "b"])).toEqual([
      ["--repo-slug", "a"],
      ["--repo-slug", "b"],
    ]);
  });
});

describe("parseValueFlags — unknown flags and bare tokens", () => {
  test("an unknown `--flag` throws (typo protection)", () => {
    expect(() => collect(["--bankid", "x"])).toThrow("unknown flag: --bankid");
  });

  test("bare tokens that follow no flag are ignored", () => {
    expect(collect(["positional", "--repo-slug", "x", "another"])).toEqual([["--repo-slug", "x"]]);
  });

  test("an empty argv is a no-op", () => {
    expect(collect([])).toEqual([]);
  });

  test("a single-dash unknown flag is ignored, not thrown on", () => {
    expect(collect(["-x"])).toEqual([]);
  });

  test("the unknown-flag check runs before any value is emitted for it", () => {
    const seen: Array<[string, string]> = [];
    expect(() =>
      parseValueFlags(["--repo-slug", "ok", "--nope", "v"], {
        flags: ["--repo-slug"],
        onValue: (f, v) => seen.push([f, v]),
        help: HELP,
      }),
    ).toThrow("unknown flag: --nope");
    expect(seen).toEqual([["--repo-slug", "ok"]]);
  });
});

// ---------------------------------------------------------------------------
// Documented contract vs actual behavior.
//
// The docblock says "`--help` / `-h`: write help to stdout and process.exit(0)"
// and "any other `--flag` → throw unknown flag". Two argv shapes fall between
// those clauses; these tests pin what the code ACTUALLY does so a future change
// is a deliberate one.
// ---------------------------------------------------------------------------
describe("parseValueFlags — documented-contract edges", () => {
  test("`--help=anything` throws unknown-flag instead of printing help", () => {
    // The `--flag=value` branch is evaluated before the help branch, so the
    // `=` form never reaches it. Divergence from the docblock's help clause.
    expect(() => collect(["--help=1"])).toThrow("unknown flag: --help");
  });

  test("a bare `--` throws unknown-flag rather than ending option parsing", () => {
    // POSIX would treat `--` as end-of-options; this parser does not, and the
    // docblock does not mention it either way.
    expect(() => collect(["--", "positional"])).toThrow("unknown flag: --");
  });

  test("a value flag shadows `--help` when it is also declared as a value flag", () => {
    expect(collect(["--help", "x"], ["--help"])).toEqual([["--help", "x"]]);
  });
});

describe("parseValueFlags — `--help` exits 0 (subprocess: process.exit)", () => {
  const libPath = path.resolve(import.meta.dir, "../../scripts/lib/cli-args.ts");

  /** Runs the parser in a child so `process.exit(0)` is observable. */
  function runHelp(arg: string) {
    const src = `import { parseValueFlags } from ${JSON.stringify(libPath)};
      parseValueFlags([${JSON.stringify(arg)}], {
        flags: ["--repo-slug"],
        onValue: () => { process.stderr.write("onValue must not fire\\n"); },
        help: ${JSON.stringify(HELP)},
      });
      process.stderr.write("returned instead of exiting\\n");
      process.exit(9);`;
    return spawnSync("bun", ["-e", src], { encoding: "utf8" });
  }

  for (const arg of ["--help", "-h"]) {
    test(`\`${arg}\` writes the help text and exits 0`, () => {
      const r = runHelp(arg);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("usage: thing");
      expect(r.stdout).toContain("--repo-slug  the slug");
      // Must not fall through to the unknown-flag throw or return normally.
      expect(r.stderr).not.toContain("returned instead of exiting");
    });
  }

  test("an unknown flag exits non-zero rather than exiting 0 like help", () => {
    const r = runHelp("--nope");
    expect(r.status).not.toBe(0);
  });
});
