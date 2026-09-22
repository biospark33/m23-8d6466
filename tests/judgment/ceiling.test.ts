/**
 * Stage-ceiling breaker tests (JEV-2 AC-5, handoff §3.2).
 *
 * A stage is one JudgmentCeiling instance held by the caller for the stage's
 * process lifetime; the counter is in-memory (per-process breaker — fine for
 * batch workloads). Refusal is typed and in-stage; there is NO per-run budget
 * admission anywhere (infrastructure tier).
 */
import { describe, expect, test } from "bun:test";
import {
  CeilingExceededError,
  DEFAULT_STAGE_CEILING_INPUT_TOKENS,
  JudgmentCeiling,
} from "../../src/judgment/ceiling.ts";

describe("JudgmentCeiling", () => {
  test("default ceiling is 1,000,000 cumulative input tokens per stage", () => {
    expect(DEFAULT_STAGE_CEILING_INPUT_TOKENS).toBe(1_000_000);
    expect(new JudgmentCeiling().ceiling).toBe(1_000_000);
    expect(new JudgmentCeiling().observedInputTokens).toBe(0);
  });

  test("admits while cumulative usage stays under the ceiling", () => {
    const c = new JudgmentCeiling(1_000);
    c.record(400);
    c.record(400);
    expect(c.observedInputTokens).toBe(800);
  });

  test("refuses further calls once cumulative observed usage crosses the ceiling", () => {
    const c = new JudgmentCeiling(1_000);
    c.record(1_200); // the crossing call itself is not retroactively refused
    let caught: CeilingExceededError | undefined;
    try {
      c.admit(); // the next judgment call in this stage
    } catch (e) {
      caught = e as CeilingExceededError;
    }
    expect(caught).toBeInstanceOf(CeilingExceededError);
    expect(caught?.observed).toBe(1_200);
    expect(caught?.ceiling).toBe(1_000);
    expect(caught?.message).toContain("1,200");
    expect(caught?.message).toContain("1,000");
  });

  test("refusal is in-stage only — a fresh stage instance starts clean", () => {
    const exhausted = new JudgmentCeiling(10);
    exhausted.record(50);
    expect(() => exhausted.admit()).toThrow(CeilingExceededError);
    expect(new JudgmentCeiling(10).admit()).toBeUndefined();
  });

  test("custom ceiling is a constructor value, not a hardcoded constant", () => {
    const c = new JudgmentCeiling(5);
    c.record(5);
    expect(() => c.admit()).toThrow(CeilingExceededError);
  });
});
