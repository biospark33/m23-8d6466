import { describe, expect, it } from "bun:test";
import {
  ComsLogCollector,
  MAX_COMS_LOG_ENTRIES,
  parseComsWireEntry,
} from "../src/coms-log.ts";

const WIRE_SNAKE = {
  request_id: "req-1",
  session_id: "sess-1",
  phase_id: "phase-1",
  channel: "lead:worker-a",
  direction: "send",
  sender_agent: "lead",
  receiver_agent: "worker-a",
  payload_size: 42,
  duration_ms: 10,
  timestamp: "2026-07-20T00:00:00.000Z",
};

describe("parseComsWireEntry", () => {
  it("maps snake_case wire fields to camelCase at the harness boundary", () => {
    const entry = parseComsWireEntry(WIRE_SNAKE);
    expect(entry).toEqual({
      requestId: "req-1",
      sessionId: "sess-1",
      phaseId: "phase-1",
      channel: "lead:worker-a",
      direction: "send",
      senderAgent: "lead",
      receiverAgent: "worker-a",
      payloadSize: 42,
      durationMs: 10,
      timestamp: "2026-07-20T00:00:00.000Z",
    });
  });

  it("accepts already-camelCase entries (idempotent boundary)", () => {
    const entry = parseComsWireEntry({
      requestId: "r",
      sessionId: "s",
      phaseId: "p",
      channel: "c",
      direction: "receive",
      senderAgent: "a",
      receiverAgent: "b",
      payloadSize: 1,
      durationMs: 2,
      timestamp: "t",
    });
    expect(entry?.direction).toBe("receive");
    expect(entry?.senderAgent).toBe("a");
  });

  it("rejects malformed entries: bad direction, missing fields, wrong types", () => {
    expect(parseComsWireEntry(null)).toBeNull();
    expect(parseComsWireEntry("x")).toBeNull();
    expect(parseComsWireEntry({ ...WIRE_SNAKE, direction: "sideways" })).toBeNull();
    const { request_id: _drop, ...missing } = WIRE_SNAKE;
    expect(parseComsWireEntry(missing)).toBeNull();
    expect(parseComsWireEntry({ ...WIRE_SNAKE, payload_size: "42" })).toBeNull();
  });

  it("coerces non-finite numerics to null (reject)", () => {
    expect(parseComsWireEntry({ ...WIRE_SNAKE, duration_ms: Number.NaN })).toBeNull();
  });
});

describe("ComsLogCollector", () => {
  it("collects valid entries and counts drops for malformed ones", () => {
    const c = new ComsLogCollector();
    expect(c.push(WIRE_SNAKE)).toBe(true);
    expect(c.push({ garbage: true })).toBe(false);
    expect(c.entries.length).toBe(1);
    expect(c.dropped).toBe(1);
  });

  it("caps stored entries at MAX_COMS_LOG_ENTRIES, counting overflow as dropped", () => {
    const c = new ComsLogCollector();
    for (let i = 0; i <= MAX_COMS_LOG_ENTRIES; i++) {
      c.push({ ...WIRE_SNAKE, request_id: `req-${i}` });
    }
    expect(c.entries.length).toBe(MAX_COMS_LOG_ENTRIES);
    expect(c.dropped).toBe(1);
  });
});
