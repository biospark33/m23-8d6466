/**
 * DF4.2 unit tests for src/lib/format.ts (AC1).
 *
 * Pure functions, no fixture needed — every branch exercised with real
 * inputs and boundary values.
 */
import { describe, expect, test } from "bun:test";
import {
  ts,
  fmtDuration,
  fmtClock,
  fmtDate,
  fmtTokens,
  fmtCost,
  fmtOffset,
  axisTicks,
  payloadOk,
  prettyJson,
} from "../../src/lib/format.ts";

describe("ts", () => {
  test("parses an ISO string to epoch millis", () => {
    expect(ts("2024-01-01T00:00:00.000Z")).toBe(Date.parse("2024-01-01T00:00:00.000Z"));
  });

  test("null/undefined → NaN", () => {
    expect(Number.isNaN(ts(null))).toBe(true);
    expect(Number.isNaN(ts(undefined))).toBe(true);
  });
});

describe("fmtDuration", () => {
  test("negative or non-finite → em dash", () => {
    expect(fmtDuration(-1)).toBe("—");
    expect(fmtDuration(Number.NaN)).toBe("—");
    expect(fmtDuration(Number.POSITIVE_INFINITY)).toBe("—");
  });

  test("sub-second renders with two decimals", () => {
    expect(fmtDuration(250)).toBe("0.25s");
  });

  test("sub-minute renders with one decimal", () => {
    expect(fmtDuration(59_500)).toBe("59.5s");
  });

  test("rounds the seconds remainder before minute math (59.5s edge)", () => {
    // 119_500ms → 119.5s rounds to 120s total, which must NOT render "1m 60s".
    expect(fmtDuration(119_500)).toBe("2m 00s");
  });

  test("sub-hour renders minutes and zero-padded seconds", () => {
    expect(fmtDuration(90_000)).toBe("1m 30s");
  });

  test("hour-plus renders hours and zero-padded minutes", () => {
    expect(fmtDuration(3_661_000)).toBe("1h 01m");
  });
});

describe("fmtClock / fmtDate", () => {
  test("fmtClock on a bad/missing timestamp → em dash", () => {
    expect(fmtClock(null)).toBe("—");
    expect(fmtClock(undefined)).toBe("—");
  });

  test("fmtClock on a real timestamp returns a non-empty clock string", () => {
    const out = fmtClock("2024-06-01T12:34:56.000Z");
    expect(out).not.toBe("—");
    expect(out.length).toBeGreaterThan(0);
  });

  test("fmtDate on a bad/missing timestamp → em dash", () => {
    expect(fmtDate(null)).toBe("—");
  });

  test("fmtDate on a real timestamp includes month/day plus the clock", () => {
    const out = fmtDate("2024-06-01T12:34:56.000Z");
    expect(out).not.toBe("—");
    expect(out).toContain(fmtClock("2024-06-01T12:34:56.000Z"));
  });
});

describe("fmtTokens", () => {
  test("null/undefined → em dash", () => {
    expect(fmtTokens(null)).toBe("—");
    expect(fmtTokens(undefined)).toBe("—");
  });

  test("under 1000 renders the raw integer", () => {
    expect(fmtTokens(0)).toBe("0");
    expect(fmtTokens(999)).toBe("999");
  });

  test("thousands render with one decimal + k", () => {
    expect(fmtTokens(1500)).toBe("1.5k");
  });

  test("millions render with two decimals + M", () => {
    expect(fmtTokens(2_500_000)).toBe("2.50M");
  });
});

describe("fmtCost", () => {
  test("null/undefined → em dash", () => {
    expect(fmtCost(null)).toBe("—");
  });

  test("zero micro-dollars → $0", () => {
    expect(fmtCost(0)).toBe("$0");
  });

  test("at least a dollar → two decimals", () => {
    expect(fmtCost(1_500_000)).toBe("$1.50");
  });

  test("sub-dollar but at least 0.0001 → four decimals", () => {
    expect(fmtCost(50_000)).toBe("$0.0500");
  });

  test("below the four-decimal floor → the literal fallback string", () => {
    expect(fmtCost(50)).toBe("<$0.0001");
  });
});

describe("fmtOffset", () => {
  test("under a minute → seconds", () => {
    expect(fmtOffset(0)).toBe("0s");
    expect(fmtOffset(30_000)).toBe("30s");
  });

  test("whole minutes with no remainder omit the seconds", () => {
    expect(fmtOffset(120_000)).toBe("2m");
  });

  test("minutes with a remainder pad the seconds", () => {
    expect(fmtOffset(90_000)).toBe("1m30s");
  });

  test("whole hours with no remainder omit the minutes", () => {
    expect(fmtOffset(3_600_000)).toBe("1h");
  });

  test("hours with a remainder pad the minutes", () => {
    expect(fmtOffset(3_600_000 + 5 * 60_000)).toBe("1h05m");
  });
});

describe("axisTicks", () => {
  test("non-finite span still produces a bounded tick set", () => {
    const ticks = axisTicks(Number.NaN);
    expect(ticks.length).toBeGreaterThan(0);
    expect(ticks.length).toBeLessThanOrEqual(9);
  });

  test("picks a preset step that keeps the tick count within maxTicks", () => {
    const ticks = axisTicks(60_000, 8);
    expect(ticks.length).toBeLessThanOrEqual(9);
    expect(ticks[0]).toEqual({ pct: 0, label: "0s" });
    const last = ticks.at(-1);
    expect(last).toBeDefined();
    expect(last?.pct).toBeLessThanOrEqual(100);
  });

  test("a span past the largest preset widens the step instead of exceeding maxTicks", () => {
    const ticks = axisTicks(100 * 3_600_000, 8);
    expect(ticks.length).toBeLessThanOrEqual(9);
  });
});

describe("payloadOk", () => {
  test("no payload → ok", () => {
    expect(payloadOk(null)).toBe(true);
    expect(payloadOk(undefined)).toBe(true);
    expect(payloadOk("")).toBe(true);
  });

  test("payload with ok:false → not ok", () => {
    expect(payloadOk('{"ok":false}')).toBe(false);
  });

  test("payload with ok:true, or no ok key at all → ok", () => {
    expect(payloadOk('{"ok":true}')).toBe(true);
    expect(payloadOk('{"tool":"bash"}')).toBe(true);
  });

  test("malformed JSON → treated as ok", () => {
    expect(payloadOk("not json")).toBe(true);
  });
});

describe("prettyJson", () => {
  test("no input → empty string", () => {
    expect(prettyJson(null)).toBe("");
    expect(prettyJson(undefined)).toBe("");
  });

  test("valid JSON is re-serialized with 2-space indent", () => {
    expect(prettyJson('{"a":1}')).toBe(JSON.stringify({ a: 1 }, null, 2));
  });

  test("invalid JSON passes through unchanged", () => {
    expect(prettyJson("not json")).toBe("not json");
  });
});
