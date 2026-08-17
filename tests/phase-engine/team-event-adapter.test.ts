/**
 * TDD tests for team-event-adapter (Story DF1.6, Task T6).
 *
 * Test-first: all tests fail before implementation exists.
 * Coverage: adaptTeamEvent, classifyRun, StreamHealth counters.
 */
import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseTeamEventLine } from "../../cli-anything/src/team-events.ts";
import {
  adaptTeamEvent,
  classifyRun,
  makeStreamHealth,
  type AdaptedEvent,
  type CostTraceEvent,
  type MergedMarker,
  type WorkerEnvelope,
} from "../../src/phase-engine/phases/team-event-adapter.ts";

describe("team-event-adapter: fixture parsing", () => {
  const fixturePath = join(
    import.meta.dir,
    "fixtures",
    "dispatch-task-ndjson.jsonl",
  );
  const fixtureLines = readFileSync(fixturePath, "utf-8").trim().split("\n");

  it("parses all 12 fixture lines without null returns", () => {
    const results = fixtureLines.map((line) => parseTeamEventLine(line));
    expect(results).toHaveLength(12);
    expect(results.every((r) => r !== null)).toBe(true);
  });

  it("adapts all parsed events without throwing", () => {
    const ctx = {
      requestId: "req-1",
      phaseId: "phase-1",
      redact: (s: string) => `[REDACTED:${s.length}]`,
    };
    const results = fixtureLines.map((line) => {
      const parsed = parseTeamEventLine(line);
      if (!parsed) throw new Error("Unparsed line");
      return adaptTeamEvent(parsed, ctx);
    });
    expect(results).toHaveLength(12);
    // No throws means successful adaptation
  });

  it("produces 6 coms trace events", () => {
    const ctx = {
      requestId: "req-1",
      phaseId: "phase-1",
      redact: (s: string) => s,
    };
    const comsEvents: AdaptedEvent[] = [];
    for (const line of fixtureLines) {
      const parsed = parseTeamEventLine(line);
      if (!parsed) continue;
      const adapted = adaptTeamEvent(parsed, ctx);
      if (adapted.type === "coms") comsEvents.push(adapted);
    }
    expect(comsEvents).toHaveLength(6);
  });

  it("produces 3 cost trace events", () => {
    const ctx = {
      requestId: "req-1",
      phaseId: "phase-1",
      redact: (s: string) => s,
    };
    const costEvents: CostTraceEvent[] = [];
    for (const line of fixtureLines) {
      const parsed = parseTeamEventLine(line);
      if (!parsed) continue;
      const adapted = adaptTeamEvent(parsed, ctx);
      if (adapted.type === "cost") costEvents.push(adapted);
    }
    expect(costEvents).toHaveLength(3);
    const first = costEvents[0]!;
    expect(first.type).toBe("cost");
    expect(first.costMicros).toBe(12345); // 0.012345 USD * 1e6
    expect(first.tokens).toBe(1500); // input + output
    expect(costEvents[1]!.tokens).toBe(3000);
  });

  it("produces 2 worker_output envelopes", () => {
    const ctx = {
      requestId: "req-1",
      phaseId: "phase-1",
      redact: (s: string) => s,
    };
    const envelopes: WorkerEnvelope[] = [];
    for (const line of fixtureLines) {
      const parsed = parseTeamEventLine(line);
      if (!parsed) continue;
      const adapted = adaptTeamEvent(parsed, ctx);
      if (adapted.type === "envelope") envelopes.push(adapted);
    }
    expect(envelopes).toHaveLength(2);
    const first = envelopes[0]!;
    expect(first.label).toBe("worker-1");
  });

  it("produces 1 merged marker", () => {
    const ctx = {
      requestId: "req-1",
      phaseId: "phase-1",
      redact: (s: string) => s,
    };
    const mergedMarkers: MergedMarker[] = [];
    for (const line of fixtureLines) {
      const parsed = parseTeamEventLine(line);
      if (!parsed) continue;
      const adapted = adaptTeamEvent(parsed, ctx);
      if (adapted.type === "merged") mergedMarkers.push(adapted);
    }
    expect(mergedMarkers).toHaveLength(1);
    const marker = mergedMarkers[0]!;
    expect(marker.type).toBe("merged");
    expect(marker.kind).toBe("merged");
    expect(marker.result).toHaveProperty("summary");
  });

  it("StreamHealth counters show zero after all valid lines", () => {
    const health = makeStreamHealth();
    for (const line of fixtureLines) {
      const parsed = parseTeamEventLine(line);
      if (!parsed) {
        health.malformed(line);
      }
      // Adapt normally (no cap check here)
    }
    const snapshot = health.snapshot();
    expect(snapshot.malformedLines).toBe(0);
    expect(snapshot.droppedOversizeLines).toBe(0);
  });
});

describe("team-event-adapter: malformed handling", () => {
  it("malformed JSON returns null from parser, increments counter", () => {
    const health = makeStreamHealth();
    const badLine = '{garbage';
    const parsed = parseTeamEventLine(badLine);
    expect(parsed).toBe(null);
    health.malformed(badLine);
    const snapshot = health.snapshot();
    expect(snapshot.malformedLines).toBe(1);
    expect(snapshot.droppedOversizeLines).toBe(0);
  });

  it("non-JSON line returns null, increments counter", () => {
    const health = makeStreamHealth();
    const badLine = "not json at all";
    const parsed = parseTeamEventLine(badLine);
    expect(parsed).toBe(null);
    health.malformed(badLine);
    const snapshot = health.snapshot();
    expect(snapshot.malformedLines).toBe(1);
    expect(snapshot.droppedOversizeLines).toBe(0);
  });

  it("malformed result object returns null (merged)", () => {
    // parseTeamEventLine rejects array/null/non-object result
    const badMerged = '{"type":"merged","result":[]}';
    const parsed = parseTeamEventLine(badMerged);
    expect(parsed).toBe(null);
  });

  it("dropped counter is separate from malformed counter", () => {
    const health = makeStreamHealth();
    health.dropped(); // Simulate cap drop
    const snapshot = health.snapshot();
    expect(snapshot.malformedLines).toBe(0);
    expect(snapshot.droppedOversizeLines).toBe(1);
  });

  it("counters persist across multiple calls", () => {
    const health = makeStreamHealth();
    health.malformed("bad1");
    health.malformed("bad2");
    health.dropped();
    health.dropped();
    health.dropped();
    const snapshot = health.snapshot();
    expect(snapshot.malformedLines).toBe(2);
    expect(snapshot.droppedOversizeLines).toBe(3);
  });
});

describe("team-event-adapter: coms payload redaction", () => {
  it("redacts secret values in coms payload", () => {
    const ctx = {
      requestId: "req-1",
      phaseId: "phase-1",
      redact: (s: string) => s.replace(/sk-1234567890/g, "[REDACTED]"),
    };
    // Coms event with fake secret riding an extra payload field — without a
    // secret in the INPUT, the not.toContain assertion below cannot detect a
    // regression that skips ctx.redact entirely.
    const comsLine = `{"type":"coms","requestId":"req-1","sessionId":"sess-1","phaseId":"phase-1","channel":"test","direction":"send","senderAgent":"a","receiverAgent":"b","payloadSize":256,"durationMs":45,"timestamp":"2026-08-17T12:00:00.000Z","message":"token is sk-1234567890"}`;
    const parsed = parseTeamEventLine(comsLine);
    expect(parsed).toBeTruthy();
    if (!parsed || parsed.kind !== "coms") throw new Error("Parse failed");

    const adapted = adaptTeamEvent(parsed, ctx);
    if (adapted.type !== "coms") throw new Error(`expected coms, got ${adapted.type}`);
    // The raw coms payload is passed through ctx.redact in payloadJson
    expect(adapted.payloadJson).toContain("[REDACTED]");
    expect(adapted.payloadJson).not.toContain("sk-1234567890");
  });
});

describe("team-event-adapter: classifyRun precedence", () => {
  it("coms_init_error beats everything -> transient", () => {
    const result = classifyRun({
      exitCode: null,
      termSignal: "SIGTERM",
      mergedResult: { summary: "ok" },
      comsInitError: true,
      killOrigin: "watchdog",
    });
    expect(result).toBe("transient");
  });

  it("watchdog signal + no merged -> overflow", () => {
    const result = classifyRun({
      exitCode: null,
      termSignal: "SIGTERM",
      mergedResult: null,
      comsInitError: false,
      killOrigin: "watchdog",
    });
    expect(result).toBe("overflow");
  });

  it("userCancel signal -> logic", () => {
    const result = classifyRun({
      exitCode: null,
      termSignal: "SIGINT",
      mergedResult: null,
      comsInitError: false,
      killOrigin: "userCancel",
    });
    expect(result).toBe("logic");
  });

  it("requestedShutdown signal -> logic", () => {
    const result = classifyRun({
      exitCode: null,
      termSignal: "SIGTERM",
      mergedResult: null,
      comsInitError: false,
      killOrigin: "requestedShutdown",
    });
    expect(result).toBe("logic");
  });

  it("unknown-origin signal -> transient", () => {
    const result = classifyRun({
      exitCode: null,
      termSignal: "SIGKILL",
      mergedResult: null,
      comsInitError: false,
      killOrigin: "unknown",
    });
    expect(result).toBe("transient");
  });

  it("null-origin signal -> transient", () => {
    const result = classifyRun({
      exitCode: null,
      termSignal: "SIGTERM",
      mergedResult: null,
      comsInitError: false,
      killOrigin: null,
    });
    expect(result).toBe("transient");
  });

  it("exit 0 + null merged -> lead_failure", () => {
    const result = classifyRun({
      exitCode: 0,
      termSignal: null,
      mergedResult: null,
      comsInitError: false,
      killOrigin: null,
    });
    expect(result).toBe("lead_failure");
  });

  it("exit 0 + valid merged -> success", () => {
    const result = classifyRun({
      exitCode: 0,
      termSignal: null,
      mergedResult: { summary: "success" },
      comsInitError: false,
      killOrigin: null,
    });
    expect(result).toBe("success");
  });

  it("exit 64 -> logic (driver config error)", () => {
    const result = classifyRun({
      exitCode: 64,
      termSignal: null,
      mergedResult: null,
      comsInitError: false,
      killOrigin: null,
    });
    expect(result).toBe("logic");
  });

  it("exit 3 -> transient (non-zero non-64)", () => {
    const result = classifyRun({
      exitCode: 3,
      termSignal: null,
      mergedResult: null,
      comsInitError: false,
      killOrigin: null,
    });
    expect(result).toBe("transient");
  });

  it("exit 64 with valid merged -> logic (UNCONDITIONAL, beats merged)", () => {
    // Per story exit table: 64 is driver config error, UNCONDITIONAL
    const result = classifyRun({
      exitCode: 64,
      termSignal: null,
      mergedResult: { summary: "ok" },
      comsInitError: false,
      killOrigin: null,
    });
    expect(result).toBe("logic");
  });

  it("array merged result (rejected upstream) arrives as null -> lead_failure", () => {
    // Genuinely exercise the upstream rejection: a merged event whose result
    // is an array is dropped by parseTeamEventLine, so classifyRun receives
    // null and the run classifies lead_failure at exit 0.
    const arrayMerged = parseTeamEventLine(`{"type":"merged","result":[1,2]}`);
    expect(arrayMerged).toBeNull();
    const result = classifyRun({
      exitCode: 0,
      termSignal: null,
      mergedResult: null,
      comsInitError: false,
      killOrigin: null,
    });
    expect(result).toBe("lead_failure");
  });
});

describe("team-event-adapter: adaptTeamEvent individual types", () => {
  const ctx = {
    requestId: "req-1",
    phaseId: "phase-1",
    redact: (s: string) => s,
  };

  it("adapts coms event to trace shape with camelCase", () => {
    const line = `{"type":"coms","requestId":"req-1","sessionId":"sess-1","phaseId":"phase-1","channel":"ch","direction":"send","senderAgent":"a","receiverAgent":"b","payloadSize":256,"durationMs":45,"timestamp":"2026-08-17T12:00:00.000Z"}`;
    const parsed = parseTeamEventLine(line);
    if (!parsed || parsed.kind !== "coms") throw new Error("Parse failed");
    const adapted = adaptTeamEvent(parsed, ctx);
    if (adapted.type !== "coms") throw new Error(`expected coms, got ${adapted.type}`);
    expect(adapted.name).toBe("coms");
    expect(adapted.payloadJson).toBeTruthy();
    const payload = JSON.parse(adapted.payloadJson);
    expect(payload).toHaveProperty("requestId"); // camelCase
    expect(payload).toHaveProperty("sessionId");
    expect(payload).toHaveProperty("phaseId");
    expect(payload).toHaveProperty("senderAgent");
    expect(payload).toHaveProperty("receiverAgent");
  });

  it("adapts cost event with tokens sum", () => {
    const line = `{"type":"cost","agentId":"worker-1","model":"anthropic/claude-sonnet-4-5","inputTokens":1000,"outputTokens":500,"cacheReadTokens":200,"cacheWriteTokens":100,"turnCount":1,"unpricedTurns":0,"durationMs":1234,"costUsd":0.012345,"timestamp":"2026-08-17T12:00:10.000Z"}`;
    const parsed = parseTeamEventLine(line);
    if (!parsed || parsed.kind !== "cost") throw new Error("Parse failed");
    const adapted = adaptTeamEvent(parsed, ctx);
    if (adapted.type !== "cost") throw new Error(`expected cost, got ${adapted.type}`);
    expect(adapted.costMicros).toBe(12345); // 0.012345 USD * 1e6
    expect(adapted.tokens).toBe(1500); // input + output
  });

  it("adapts worker_output to generic envelope", () => {
    const line = `{"type":"worker_output","agentId":"worker-1","output":{"summary":"Done","result":{"status":"ok"}}}`;
    const parsed = parseTeamEventLine(line);
    if (!parsed || parsed.kind !== "worker_output") throw new Error("Parse failed");
    const adapted = adaptTeamEvent(parsed, ctx);
    if (adapted.type !== "envelope") throw new Error(`expected envelope, got ${adapted.type}`);
    expect(adapted.kind).toBe("generic");
    expect(adapted.label).toBe("worker-1");
    expect(adapted.status).toBe("success"); // from output status
  });

  it("honors every valid ExitStatus a worker declares — none rewritten to success", () => {
    // Regression: the derivation used to recognize only logic/overflow, so a
    // worker's real "transient"/"lead_failure" was silently rewritten to
    // "success", masking the failure.
    for (const status of ["logic", "overflow", "transient", "lead_failure"] as const) {
      const line = `{"type":"worker_output","agentId":"worker-1","output":{"status":"${status}"}}`;
      const parsed = parseTeamEventLine(line);
      if (!parsed || parsed.kind !== "worker_output") throw new Error("Parse failed");
      const adapted = adaptTeamEvent(parsed, ctx);
      if (adapted.type !== "envelope") throw new Error(`expected envelope, got ${adapted.type}`);
      expect(adapted.status).toBe(status);
    }
    // Unknown/absent status still defaults to success.
    const okLine = `{"type":"worker_output","agentId":"worker-1","output":{"summary":"done"}}`;
    const okParsed = parseTeamEventLine(okLine);
    if (!okParsed || okParsed.kind !== "worker_output") throw new Error("Parse failed");
    const okAdapted = adaptTeamEvent(okParsed, ctx);
    if (okAdapted.type !== "envelope") throw new Error("expected envelope");
    expect(okAdapted.status).toBe("success");
    const bogusLine = `{"type":"worker_output","agentId":"worker-1","output":{"status":"bogus"}}`;
    const bogusParsed = parseTeamEventLine(bogusLine);
    if (!bogusParsed || bogusParsed.kind !== "worker_output") throw new Error("Parse failed");
    const bogusAdapted = adaptTeamEvent(bogusParsed, ctx);
    if (bogusAdapted.type !== "envelope") throw new Error("expected envelope");
    expect(bogusAdapted.status).toBe("success");
  });

  it("adapts merged to terminal marker", () => {
    const line = `{"type":"merged","result":{"summary":"Team done","workerSummaries":[]}}`;
    const parsed = parseTeamEventLine(line);
    if (!parsed || parsed.kind !== "merged") throw new Error("Parse failed");
    const adapted = adaptTeamEvent(parsed, ctx);
    if (adapted.type !== "merged") throw new Error(`expected merged, got ${adapted.type}`);
    expect(adapted.kind).toBe("merged");
    expect(adapted.result).toHaveProperty("summary");
  });

  it("adapts coms_init_error to trace event", () => {
    const line = `{"type":"coms_init_error","reason":"Connection failed"}`;
    const parsed = parseTeamEventLine(line);
    if (!parsed || parsed.kind !== "coms_init_error") throw new Error("Parse failed");
    const adapted = adaptTeamEvent(parsed, ctx);
    if (adapted.type !== "coms_init_error")
      throw new Error(`expected coms_init_error, got ${adapted.type}`);
    expect(adapted.name).toBe("coms_init_error");
  });
});
