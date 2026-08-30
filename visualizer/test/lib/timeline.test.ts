/**
 * Task 7.1 / F027 unit tests for src/lib/timeline.ts — the session card's
 * dot geometry and, above all, its bound on how many spans a row may emit.
 */
import { describe, expect, test } from "bun:test";
import {
  DOT_SLOTS,
  bucketDots,
  timelineRows,
  type Placed,
} from "../../src/lib/timeline.ts";
import type { AgentSession, EventRow, Phase } from "../../src/lib/types.ts";

function placed(xPct: number, severity = 0, latest = false): Placed & { id: string } {
  return { id: `${xPct}:${severity}`, xPct, severity, latest };
}

function phase(overrides: Partial<Phase>): Phase {
  return {
    phase_id: "p1",
    request_id: "req-1",
    seq: 0,
    name: null,
    kind: "agent",
    owner: "builder",
    description: null,
    status: null,
    attempt: null,
    retries: null,
    error: null,
    started_at: null,
    ended_at: null,
    ...overrides,
  };
}

const T0 = Date.parse("2026-01-01T00:00:00.000Z");
const SPAN = 10_000;

function at(ms: number, overrides: Partial<EventRow> = {}): EventRow {
  return {
    rowid: ms,
    event_id: `ev-${ms}-${overrides.type ?? "tool_call"}`,
    request_id: "req-1",
    phase_id: "p1",
    parent_id: null,
    type: "tool_call",
    name: null,
    payload_json: null,
    tokens: null,
    started_at: new Date(T0 + ms).toISOString(),
    ended_at: null,
    ...overrides,
  };
}

function agent(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    request_id: "req-1",
    agent: "builder",
    coding_agent: null,
    model: null,
    session_id: null,
    color: null,
    context_tokens: null,
    context_window: null,
    ...overrides,
  };
}

describe("bucketDots", () => {
  test("a row shorter than the slot count is returned untouched", () => {
    const dots = [placed(1), placed(2), placed(3)];
    expect(bucketDots(dots, 100)).toBe(dots);
  });

  test("collapses dots sharing a column to one span per column", () => {
    // 500 dots spread across the full track, 10 columns → at most 10 spans.
    const dots = Array.from({ length: 500 }, (_, i) => placed((i / 499) * 100));
    const out = bucketDots(dots, 10);
    expect(out.length).toBeLessThanOrEqual(10);
    expect(out.length).toBeGreaterThan(0);
  });

  test("the loudest event in a column is the one that survives", () => {
    // All in column 0; the error must win over the routine dots after it.
    const dots = [placed(0.1, 0), placed(0.2, 3), placed(0.3, 0), placed(0.4, 0)];
    const out = bucketDots(dots, 2);
    expect(out).toHaveLength(1);
    expect(out[0]?.severity).toBe(3);
  });

  test("ties go to the most recent dot in the column", () => {
    const dots = [placed(0.1, 1), placed(0.2, 1), placed(0.3, 1), placed(0.4, 1)];
    const out = bucketDots(dots, 2);
    expect(out[0]?.xPct).toBe(0.4);
  });

  test("the live cursor is never swallowed by a louder neighbour", () => {
    const dots = [placed(0.1, 3), placed(0.2, 0, true), placed(0.3, 3), placed(0.4, 3)];
    const out = bucketDots(dots, 2);
    expect(out).toHaveLength(1);
    expect(out[0]?.latest).toBe(true);
  });

  test("output stays left-to-right so the track reads in time order", () => {
    const dots = Array.from({ length: 400 }, (_, i) => placed(100 - (i / 399) * 100));
    const out = bucketDots(dots, 20);
    const xs = out.map((d) => d.xPct);
    expect(xs).toEqual([...xs].toSorted((a, b) => a - b));
  });

  test("a nonsense slot count degrades to a single column, never a divide by zero", () => {
    const dots = [placed(10), placed(50), placed(90)];
    const out = bucketDots(dots, 0);
    expect(out).toHaveLength(1);
    expect(Number.isFinite(out[0]?.xPct ?? Number.NaN)).toBe(true);
  });

  test("dots at the 100% edge land in the last column, not past it", () => {
    const out = bucketDots([placed(100, 0), placed(100, 3), placed(0, 0)], 2);
    expect(out).toHaveLength(2);
    expect(out.at(-1)?.severity).toBe(3);
  });
});

describe("timelineRows", () => {
  const base = {
    phases: [phase({})],
    agents: [agent()],
    t0: T0,
    span: SPAN,
    running: false,
  };

  test("no agent phases → no rows", () => {
    expect(
      timelineRows({ ...base, phases: [phase({ kind: "code", owner: null })], events: [] }),
    ).toEqual([]);
  });

  test("one row per agent owner, in phase order", () => {
    const rows = timelineRows({
      ...base,
      phases: [
        phase({ phase_id: "p1", owner: "planner" }),
        phase({ phase_id: "p2", owner: "builder" }),
        phase({ phase_id: "p3", owner: "planner" }),
      ],
      agents: [agent({ agent: "builder", color: "#123456", model: "gpt-5" })],
      events: [],
    });
    expect(rows.map((r) => r.owner)).toEqual(["planner", "builder"]);
    expect(rows[1]?.color).toBe("#123456");
    expect(rows[1]?.title).toBe("builder gpt-5");
    expect(rows[0]?.title).toBe("planner");
  });

  test("places a dot at its share of the span and carries a readable title", () => {
    const rows = timelineRows({ ...base, events: [at(2500, { name: "bash: ls" })] });
    expect(rows[0]?.dots).toHaveLength(1);
    expect(rows[0]?.dots[0]?.xPct).toBe(25);
    expect(rows[0]?.dots[0]?.title).toContain("tool_call");
    expect(rows[0]?.dots[0]?.title).toContain("bash: ls");
  });

  test("events outside the span clamp onto the track rather than escaping it", () => {
    const rows = timelineRows({ ...base, events: [at(-5000), at(50_000)] });
    expect(rows[0]?.dots.map((d) => d.xPct)).toEqual([0, 100]);
  });

  test("uncolored types, foreign phases and unparseable timestamps are skipped", () => {
    const rows = timelineRows({
      ...base,
      events: [
        at(1000, { type: "log" }),
        at(2000, { phase_id: "other" }),
        at(3000, { started_at: "not a date" }),
        at(4000),
      ],
    });
    expect(rows[0]?.dots).toHaveLength(1);
  });

  test("only a running session marks its most recent dot as the live cursor", () => {
    const events = [at(1000), at(9000)];
    expect(timelineRows({ ...base, events }).some((r) => r.dots.some((d) => d.latest))).toBe(false);
    const live = timelineRows({ ...base, running: true, events });
    expect(live[0]?.dots.filter((d) => d.latest).map((d) => d.xPct)).toEqual([90]);
  });

  test("5,000 events on one row emit at most DOT_SLOTS spans", () => {
    const events = Array.from({ length: 5000 }, (_, i) => at(i * 2));
    const rows = timelineRows({ ...base, events });
    expect(rows[0]?.dots.length).toBeLessThanOrEqual(DOT_SLOTS);
  });

  test("bucketing keeps the errors — a failed run still reads as failed", () => {
    const events = Array.from({ length: 5000 }, (_, i) =>
      at(i * 2, i === 2500 ? { type: "error", event_id: "boom" } : {}),
    );
    const rows = timelineRows({ ...base, events });
    expect(rows[0]?.dots.some((d) => d.id === "boom")).toBe(true);
  });

  test("a custom slot count is honoured", () => {
    const events = Array.from({ length: 5000 }, (_, i) => at(i * 2));
    const rows = timelineRows({ ...base, events, slots: 12 });
    expect(rows[0]?.dots.length).toBeLessThanOrEqual(12);
  });
});
