/**
 * Usage accumulation tests (Story DF1.3).
 *
 * The asymmetry this file exists to pin: every send costs, so usage
 * accumulates; every send continues the same context, so only the last send's
 * occupancy is current — and an aborted/errored turn must not overwrite a good
 * occupancy reading (R4 §1.10; AC3).
 *
 * Also pins the unit boundary (DD-9, INV-3): µ$ integers inside the engine,
 * exactly one conversion to USD at the phase-engine → runner call site.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  type SendUsage,
  UsageAccumulator,
  usdFromMicros,
} from "../../src/phase-engine/usage.ts";

function usage(over: Partial<SendUsage> = {}): SendUsage {
  return {
    inputTokens: 1_000,
    outputTokens: 200,
    cacheReadTokens: 5_000,
    cacheWriteTokens: 0,
    reasoningTokens: 50,
    costMicros: 1_000_000,
    ...over,
  };
}

describe("UsageAccumulator — spend accumulates over every send", () => {
  test("merges field-wise across sends; a retried phase reports the full spend", () => {
    const acc = new UsageAccumulator();
    acc.add(usage({ inputTokens: 100, outputTokens: 10, costMicros: 500_000 }));
    acc.add(usage({ inputTokens: 50, outputTokens: 5, costMicros: 250_000 }));
    acc.add(usage({ inputTokens: 25, outputTokens: 2, costMicros: 1_750_000 }));
    expect(acc.spent).toEqual({
      inputTokens: 175,
      outputTokens: 17,
      cacheReadTokens: 15_000,
      cacheWriteTokens: 0,
      reasoningTokens: 150,
      costMicros: 2_500_000,
      sends: 3,
    });
  });

  test("DoD boundary: 2_500_000 µ$ over three sends surfaces 2_500_000 on the accumulator and exactly 2.5 USD at the one conversion site", () => {
    const acc = new UsageAccumulator();
    acc.add(usage({ costMicros: 500_000, inputTokens: 0, outputTokens: 0 }));
    acc.add(usage({ costMicros: 1_000_000, inputTokens: 0, outputTokens: 0 }));
    acc.add(usage({ costMicros: 1_000_000, inputTokens: 0, outputTokens: 0 }));
    expect(acc.spent.costMicros).toBe(2_500_000);
    // The phase-engine → runner call site (INV-3): micros / 1_000_000, once.
    expect(usdFromMicros(acc.spent.costMicros)).toBe(2.5);
  });

  test("input excludes cache reads; reasoningTokens is a nested share of output, never a fifth component", () => {
    const acc = new UsageAccumulator();
    acc.add(usage({ inputTokens: 100, cacheReadTokens: 9_900, outputTokens: 400, reasoningTokens: 100 }));
    // Four token components only; reasoning is reported inside outputTokens' share.
    const s = acc.spent;
    expect(s.inputTokens).toBe(100);
    expect(s.cacheReadTokens).toBe(9_900);
    expect(s.cacheWriteTokens).toBe(0);
    expect(s.outputTokens).toBe(400);
    expect(s.reasoningTokens).toBe(100);
    expect(Object.keys(s).sort()).toEqual(
      ["cacheReadTokens", "cacheWriteTokens", "costMicros", "inputTokens", "outputTokens", "reasoningTokens", "sends"].sort(),
    );
  });

  test("rejects negative or non-finite cost at the accumulator boundary (a silent under-report disarms the budget kill)", () => {
    const acc = new UsageAccumulator();
    expect(() => acc.add(usage({ costMicros: -1 }))).toThrow();
    expect(() => acc.add(usage({ costMicros: Number.NaN }))).toThrow();
    expect(() => acc.add(usage({ costMicros: Number.POSITIVE_INFINITY }))).toThrow();
    expect(acc.spent.costMicros).toBe(0);
  });
});

describe("UsageAccumulator — occupancy reads the last send only", () => {
  test("a 3-send phase where send 3 reports stopReason aborted sums all 3 sends but keeps send 2's occupancy", () => {
    const acc = new UsageAccumulator();
    acc.add(usage({ costMicros: 1 }), { contextTokens: 10_000 });
    acc.add(usage({ costMicros: 1 }), { contextTokens: 20_000 });
    acc.add(usage({ costMicros: 1 }), { contextTokens: 99_999, stopReason: "aborted" });
    expect(acc.spent.sends).toBe(3);
    expect(acc.latestContextTokens).toBe(20_000);
  });

  test("stopReason error is skipped the same as aborted", () => {
    const acc = new UsageAccumulator();
    acc.add(usage(), { contextTokens: 5_000 });
    acc.add(usage(), { contextTokens: 6_000, stopReason: "error" });
    expect(acc.latestContextTokens).toBe(5_000);
  });

  test("no occupancy observed yet reads 0 (unknown, never full)", () => {
    expect(new UsageAccumulator().latestContextTokens).toBe(0);
  });
});

describe("Unit boundary — µ$ inside, USD only at the one call site (DD-9, INV-3)", () => {
  const engineRoot = path.resolve(import.meta.dir, "../../src/phase-engine");

  /**
   * Code-only view of a source file (review round 6): blanks // and
   * block comments AND string/template/char literals (escape-aware, block
   * state carries across lines) so the invariant scans executable code,
   * not prose, comments, or literal text. Regex literals are not lexed —
   * a known ceiling shared with the dp gate's blanker.
   */
  function codeOnly(text: string): string {
    let inBlock = false;
    let inStr: '"' | "'" | "`" | null = null;
    return text
      .split("\n")
      .map((line) => {
        let out = "";
        for (let i = 0; i < line.length; i += 1) {
          const c = line[i]!;
          const two = line.slice(i, i + 2);
          if (inBlock) {
            if (two === "*/") {
              inBlock = false;
              out += "  ";
              i += 1;
            } else out += " ";
            continue;
          }
          if (inStr) {
            if (c === "\\") {
              out += "  ";
              i += 1; // skip the escaped char
            } else if (c === inStr) {
              inStr = null;
              out += " ";
            } else out += " ";
            continue;
          }
          if (two === "//") break; // rest of the line is a comment
          if (two === "/*") {
            inBlock = true;
            out += "  ";
            i += 1;
            continue;
          }
          if (c === '"' || c === "'" || c === "`") {
            inStr = c;
            out += " ";
            continue;
          }
          out += c;
        }
        return out;
      })
      .join("\n");
  }

  test("no float-dollar field exists anywhere inside src/phase-engine", () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
          const code = codeOnly(fs.readFileSync(full, "utf8"));
          if (/costUsd|costCents|usd:\s|dollars/.test(code)) offenders.push(full);
        }
      }
    };
    walk(engineRoot);
    expect(offenders).toEqual([]);
  });

  test("exactly one micros→USD DIVISION exists in the engine, in usage.ts", () => {
    const usage = codeOnly(fs.readFileSync(path.join(engineRoot, "usage.ts"), "utf8"));
    expect((usage.match(/\/\s*1_000_000/g) ?? []).length).toBe(1);
    // No other engine file divides by a million (DF1.5's roster rate math
    // multiplies tokens into µ$ — different direction, different unit contract).
    const others: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".ts") && path.resolve(dir, entry.name) !== path.join(engineRoot, "usage.ts")) {
          if (/\/\s*1_000_000/.test(codeOnly(fs.readFileSync(full, "utf8")))) others.push(full);
        }
      }
    };
    walk(engineRoot);
    expect(others).toEqual([]);
  });

  test("usdFromMicros never rounds and never converts back", () => {
    expect(usdFromMicros(0)).toBe(0);
    expect(usdFromMicros(1)).toBe(0.000001);
    expect(usdFromMicros(5_000_000)).toBe(5);
  });
});
