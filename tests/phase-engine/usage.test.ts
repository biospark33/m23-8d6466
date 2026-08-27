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
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
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
   * Code-only view of a source file, SINGLE-SOURCED with the dp gate's
   * blanker (review round 7): shells out to
   * `check-defensive-programming.sh --code-only`, so a lexer fix lands in
   * the D017/D020 gate and this invariant scan at once — the previous local
   * copy had already drifted from the awk one. Blanks // and block comments
   * and string/char/template literals (escape-aware, state carries across
   * lines) while KEEPING ${...} interpolation expressions visible — the
   * scan sees executable code, not prose. Known ceilings: regex literals;
   * nested templates inside an interpolation.
   */
  function codeOnly(file: string): string {
    return execFileSync(
      path.resolve(import.meta.dir, "../../scripts/dev/check-defensive-programming.sh"),
      ["--code-only", file],
      { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
    );
  }

  test("code-only view keeps interpolation code visible and template text blanked (round 7 — single-sourced with the dp gate)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "df13-codeonly-"));
    const fixture = path.join(dir, "fixture.ts");
    try {
      fs.writeFileSync(fixture, 'const msg = `Cost: ${cost / 1_000_000} USD`;\n');
      const firstLine = codeOnly(fixture).split("\n")[0]!;
      expect(/\/\s*1_000_000/.test(firstLine)).toBe(true);
      expect(firstLine.includes("USD")).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("no float-dollar field exists anywhere inside src/phase-engine", () => {
    const offenders: string[] = [];
    const adapterPath = path.join(engineRoot, "phases", "team-event-adapter.ts");
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
          // Adapter is exempt: contains ONE sanctioned USD→µ$ conversion at DF1.3 boundary
          if (full === adapterPath) continue;
          const code = codeOnly(full);
          if (/costUsd|costCents|usd:\s|dollars/.test(code)) offenders.push(full);
        }
      }
    };
    walk(engineRoot);
    expect(offenders).toEqual([]);
    // 20s: recursive src scan can outrun bun's 5s default under
    // parallel-suite load on a saturated host — deterministic solo.
  }, 20_000);

  test("exactly one micros→USD DIVISION exists in the engine, in usage.ts", () => {
    const usage = codeOnly(path.join(engineRoot, "usage.ts"));
    expect((usage.match(/\/\s*1_000_000/g) ?? []).length).toBe(1);
    // No other engine file divides by a million (DF1.5's roster rate math
    // multiplies tokens into µ$ — different direction, different unit contract).
    // AMENDED DF3.3: steering.ts is the one sanctioned ENGINE-SIDE tokens→µ$
    // projection site — the story's Technical Notes ("every consumer divides
    // by 1e6 at the projection") and validate.ts's own docstring define the
    // contract; fleet-side projections (DF3.2) live outside this walk.
    const steeringPath = path.join(engineRoot, "steering.ts");
    // COMPENSATING PIN for the steering.ts exemption above: the file is
    // excluded from the no-other-division walk, so a NEW division there would
    // pass this suite unexamined. The meter is exactly two terms — input
    // tokens and output tokens, each `/ 1_000_000` (integer µ$ per DD-9,
    // rounded per term) — and any additional division is a new conversion
    // site that must be argued, not smuggled in.
    const steering = codeOnly(steeringPath);
    expect((steering.match(/\/\s*1_000_000/g) ?? []).length).toBe(2);
    const others: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (
          entry.name.endsWith(".ts") &&
          path.resolve(dir, entry.name) !== path.join(engineRoot, "usage.ts") &&
          path.resolve(dir, entry.name) !== steeringPath
        ) {
          if (/\/\s*1_000_000/.test(codeOnly(full))) others.push(full);
        }
      }
    };
    walk(engineRoot);
    expect(others).toEqual([]);
    // 20s: same load-flake family as the scan above — recursive src read.
  }, 20_000);

  test("exactly one USD→µ$ MULTIPLICATION exists in the engine, in team-event-adapter.ts (DF1.3 boundary)", () => {
    const adapterPath = path.join(engineRoot, "phases", "team-event-adapter.ts");
    const adapter = codeOnly(adapterPath);
    // Exactly ONE costUsd reference (the sanctioned inbound conversion site)
    expect((adapter.match(/costUsd/g) ?? []).length).toBe(1);
    // Exactly ONE multiplication by 1_000_000 (the USD→µ$ conversion)
    expect((adapter.match(/\*\s*1_000_000/g) ?? []).length).toBe(1);
  });

  test("usdFromMicros never rounds and never converts back", () => {
    expect(usdFromMicros(0)).toBe(0);
    expect(usdFromMicros(1)).toBe(0.000001);
    expect(usdFromMicros(5_000_000)).toBe(5);
  });
});
