/**
 * DF4.2 coverage-gate tests. Crafted lcov fixture STRINGS only — never the
 * real coverage run (a test can't read its own run's final lcov.info; the
 * CLI entry that does is behind `import.meta.main` in check-lcov.ts).
 */
import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { checkCoverage, parseLcov } from "../scripts/check-lcov.ts";

const CWD = "/repo/visualizer";
const abs = (rel: string) => path.resolve(CWD, rel);

const record = (sf: string, fnf: number, fnh: number, lf: number, lh: number) =>
  `SF:${sf}\nFNF:${fnf}\nFNH:${fnh}\nLF:${lf}\nLH:${lh}\nend_of_record\n`;

describe("parseLcov", () => {
  test("normalises SF paths to absolute, resolved against cwd", () => {
    const lcov = record("server/auth.ts", 3, 3, 10, 10);
    const records = parseLcov(lcov, CWD);
    expect(records.has(abs("server/auth.ts"))).toBe(true);
  });

  test("normalises a ../-prefixed SF path (file outside the run cwd)", () => {
    const lcov = record("../src/phase-engine/types.ts", 1, 1, 5, 5);
    const records = parseLcov(lcov, CWD);
    expect(records.has(abs("../src/phase-engine/types.ts"))).toBe(true);
    // and it lands on the same absolute path a naive string-prefix match
    // would miss: resolved outside CWD entirely.
    expect(abs("../src/phase-engine/types.ts")).toBe("/repo/src/phase-engine/types.ts");
  });

  test("parses multiple records", () => {
    const lcov = record("a.ts", 1, 1, 2, 2) + record("b.ts", 2, 0, 4, 1);
    const records = parseLcov(lcov, CWD);
    expect(records.size).toBe(2);
    expect(records.get(abs("b.ts"))).toEqual({ fnf: 2, fnh: 0, lf: 4, lh: 1 });
  });

  test("a malformed counter (nonnumeric) throws instead of coercing to NaN", () => {
    const lcov = "SF:a.ts\nFNF:notanumber\nFNH:1\nLF:2\nLH:2\nend_of_record\n";
    expect(() => parseLcov(lcov, CWD)).toThrow("Invalid LCOV counter: FNF:notanumber");
  });

  test("a negative counter throws", () => {
    const lcov = "SF:a.ts\nFNF:1\nFNH:-1\nLF:2\nLH:2\nend_of_record\n";
    expect(() => parseLcov(lcov, CWD)).toThrow("Invalid LCOV counter: FNH:-1");
  });

  test("an empty counter (bare `FNF:` with no value) throws instead of coercing to 0", () => {
    const lcov = "SF:a.ts\nFNF:\nFNH:1\nLF:2\nLH:2\nend_of_record\n";
    expect(() => parseLcov(lcov, CWD)).toThrow("Invalid LCOV counter: FNF:");
  });

  test("a whitespace-only counter throws instead of coercing to 0", () => {
    const lcov = "SF:a.ts\nFNF:1\nFNH:1\nLF:   \nLH:2\nend_of_record\n";
    expect(() => parseLcov(lcov, CWD)).toThrow("Invalid LCOV counter: LF:   ");
  });
});

describe("checkCoverage", () => {
  test("(a) a module at 40% lines FAILS", () => {
    const lcov = record("server/foo.ts", 2, 2, 10, 4); // 100% funcs, 40% lines
    const records = parseLcov(lcov, CWD);
    const result = checkCoverage(records, [abs("server/foo.ts")]);
    expect(result.ok).toBe(false);
    expect(result.failures.join("\n")).toContain("server/foo.ts");
  });

  test("(b) a MISSING record for an expected file FAILS", () => {
    const records = parseLcov("", CWD);
    const result = checkCoverage(records, [abs("src/lib/api.ts")]);
    expect(result.ok).toBe(false);
    expect(result.failures.join("\n")).toMatch(/missing/i);
    expect(result.failures.join("\n")).toContain("src/lib/api.ts");
  });

  test("(c) a module at 100% lines / 50% functions FAILS", () => {
    const lcov = record("server/bar.ts", 4, 2, 8, 8); // 100% lines, 50% funcs
    const records = parseLcov(lcov, CWD);
    const result = checkCoverage(records, [abs("server/bar.ts")]);
    expect(result.ok).toBe(false);
    expect(result.failures.join("\n")).toContain("server/bar.ts");
  });

  test("a fixture where everything passes returns success", () => {
    const lcov =
      record("server/auth.ts", 3, 3, 10, 10) + record("src/lib/format.ts", 5, 5, 20, 19); // 100% funcs, 95% lines
    const records = parseLcov(lcov, CWD);
    const result = checkCoverage(records, [abs("server/auth.ts"), abs("src/lib/format.ts")]);
    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
  });

  test("LF:0/FNF:0 pure type re-export passes vacuously", () => {
    const lcov = record("src/lib/types.ts", 0, 0, 0, 0);
    const records = parseLcov(lcov, CWD);
    const result = checkCoverage(records, [abs("src/lib/types.ts")]);
    expect(result.ok).toBe(true);
  });

  test("LF:0 with FNF>0 is suspicious and FAILS (never divides by zero)", () => {
    const lcov = record("src/lib/weird.ts", 3, 0, 0, 0);
    const records = parseLcov(lcov, CWD);
    const result = checkCoverage(records, [abs("src/lib/weird.ts")]);
    expect(result.ok).toBe(false);
    expect(result.failures.join("\n")).toContain("src/lib/weird.ts");
  });

  test("a ../-prefixed expected file matches its record after normalisation", () => {
    const lcov = record("../src/phase-engine/types.ts", 1, 1, 5, 5);
    const records = parseLcov(lcov, CWD);
    const result = checkCoverage(records, [abs("../src/phase-engine/types.ts")]);
    expect(result.ok).toBe(true);
  });

  test("multiple failures are all reported, not just the first", () => {
    const lcov = record("server/foo.ts", 1, 1, 10, 1) + record("server/bar.ts", 4, 1, 8, 8);
    const records = parseLcov(lcov, CWD);
    const result = checkCoverage(records, [abs("server/foo.ts"), abs("server/bar.ts")]);
    expect(result.ok).toBe(false);
    expect(result.failures.length).toBe(2);
  });
});
