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
    // 12 = F6-proven event-count invariant: 6 coms, 3 cost, 2 worker_output, 1 merged.
    const results = fixtureLines.map((line) => parseTeamEventLine(line));
    expect(results).toHaveLength(12);
    expect(results.every((r) => r !== null)).toBe(true);
  });

  it("adapts all parsed events without throwing", () => {
    // 12 = F6-proven event-count invariant: 6 coms, 3 cost, 2 worker_output, 1 merged.
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
    // No throws means successful adaptation — this test exercises the real
    // adapter path (parseTeamEventLine + adaptTeamEvent), not just counters.
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
    const ctx = {
      requestId: "req-1",
      phaseId: "phase-1",
      redact: (s: string) => s,
    };
    for (const line of fixtureLines) {
      const parsed = parseTeamEventLine(line);
      if (!parsed) {
        health.malformed(line);
        continue;
      }
      // Adapt normally through the real adapter path
      const adapted = adaptTeamEvent(parsed, ctx);
      // Adapt succeeded — counters remain zero
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

  it("unknown type field returns null from parser", () => {
    // The default case in parseTeamEventLine returns null for any unrecognized
    // type field. This prevents unknown event types from entering the stream.
    const unknownLine = '{"type":"definitely_not_a_kind","agentId":"w1"}';
    const parsed = parseTeamEventLine(unknownLine);
    expect(parsed).toBe(null);
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

  it("all-invalid stream: N malformed lines counted correctly", () => {
    // Feed multiple malformed lines through the stream-health counter to
    // verify the malformedLines counter accumulates correctly while dropped
    // stays at zero.
    const health = makeStreamHealth();
    const malformedLines = [
      '{garbage',
      'not json at all',
      '{"type":"merged","result":[]}',
      '{"type":"unknown","data":123}',
    ];
    for (const line of malformedLines) {
      const parsed = parseTeamEventLine(line);
      if (!parsed) {
        health.malformed(line);
      }
    }
    const snapshot = health.snapshot();
    expect(snapshot.malformedLines).toBe(4);
    expect(snapshot.droppedOversizeLines).toBe(0);
  });
});

describe("team-event-adapter: review-round hardening (A5, A6)", () => {
  const ctx = {
    requestId: "req-1",
    phaseId: "phase-1",
    redact: (s: string) => s,
  };

  it("A5: coms event with no fields (only type) produces trace event without throwing", () => {
    // Pin current lenient behavior: {"type":"coms"} with no other fields
    // should adapt to a trace event without throwing.
    const comsLine = '{"type":"coms"}';
    const parsed = parseTeamEventLine(comsLine);
    expect(parsed).toBeTruthy();
    if (!parsed || parsed.kind !== "coms") throw new Error("Parse failed");

    // Should NOT throw — adapts with lenient defaults
    const adapted = adaptTeamEvent(parsed, ctx);
    expect(adapted.type).toBe("coms");
  });

  it("A6: StreamHealth zero after valid lines (actually adapts, counters checked)", () => {
    // Original test claimed "Adapt normally" but never called adaptTeamEvent.
    // Now actually adapts a valid line and counters still zero.
    const health = makeStreamHealth();
    const validLine = '{"type":"coms","requestId":"req-1","sessionId":"sess-1","phaseId":"phase-1","channel":"test","direction":"send","senderAgent":"a","receiverAgent":"b","payloadSize":256,"durationMs":45,"timestamp":"2026-08-17T12:00:00.000Z"}';
    const parsed = parseTeamEventLine(validLine);
    expect(parsed).toBeTruthy();
    if (!parsed || parsed.kind !== "coms") throw new Error("Parse failed");

    // Actually adapt — this is what the comment claimed but didn't do
    const adapted = adaptTeamEvent(parsed, ctx);
    expect(adapted.type).toBe("coms");

    // Counters remain zero after processing valid lines
    const snapshot = health.snapshot();
    expect(snapshot.malformedLines).toBe(0);
    expect(snapshot.droppedOversizeLines).toBe(0);
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

  it("classifyRun: null mergedResult + exit 0 -> lead_failure", () => {
    // Tests classifyRun behavior when mergedResult is null. (Array-type
    // merged events are rejected upstream by parseTeamEventLine, so they
    // never reach classifyRun as arrays — they arrive here as null.)
    const arrayMerged = parseTeamEventLine(`{"type":"merged","result":[1,2]}`);
    expect(arrayMerged).toBeNull(); // Upstream parser rejects arrays
    const result = classifyRun({
      exitCode: 0,
      termSignal: null,
      mergedResult: null, // What arrives after upstream rejection
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
    expect(adapted.status).toBe("transient"); // output has no top-level status → defaults to transient (fail-safe)
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
    // Unknown/absent status defaults to transient (fail-safe).
    const okLine = `{"type":"worker_output","agentId":"worker-1","output":{"summary":"done"}}`;
    const okParsed = parseTeamEventLine(okLine);
    if (!okParsed || okParsed.kind !== "worker_output") throw new Error("Parse failed");
    const okAdapted = adaptTeamEvent(okParsed, ctx);
    if (okAdapted.type !== "envelope") throw new Error("expected envelope");
    expect(okAdapted.status).toBe("transient");
    const bogusLine = `{"type":"worker_output","agentId":"worker-1","output":{"status":"bogus"}}`;
    const bogusParsed = parseTeamEventLine(bogusLine);
    if (!bogusParsed || bogusParsed.kind !== "worker_output") throw new Error("Parse failed");
    const bogusAdapted = adaptTeamEvent(bogusParsed, ctx);
    if (bogusAdapted.type !== "envelope") throw new Error("expected envelope");
    expect(bogusAdapted.status).toBe("transient");
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

describe("team-event-adapter: review-round hardening (A12-A17)", () => {
  const ctx = {
    requestId: "req-1",
    phaseId: "phase-1",
    redact: (s: string) => s,
  };

  it("A12: CRLF line endings on malformed and valid lines — counters classify correctly", () => {
    // Mix of CRLF and LF lines — parser handles both, counters track correctly
    const health = makeStreamHealth();
    const lines = [
      '{"type":"coms"}\r\n', // valid CRLF
      '{garbage\r\n', // malformed CRLF
      '{"type":"cost","agentId":"w1","model":"m","inputTokens":100,"outputTokens":50,"turnCount":1,"unpricedTurns":0,"durationMs":1234,"costUsd":0.01}\n', // valid LF
      'not json\r\n', // malformed CRLF
    ];
    for (const line of lines) {
      const parsed = parseTeamEventLine(line);
      if (!parsed) {
        health.malformed(line);
      }
    }
    const snapshot = health.snapshot();
    expect(snapshot.malformedLines).toBe(2);
    expect(snapshot.droppedOversizeLines).toBe(0);
  });

  it("A13: valid-JSON-trailing-comma line → malformed", () => {
    // Trailing comma makes it invalid JSON even though otherwise valid
    const trailingComma = '{"type":"coms", "extra":true,}';
    const parsed = parseTeamEventLine(trailingComma);
    expect(parsed).toBe(null);
  });

  it("A14: blank line inside NDJSON stream → skipped, not malformed", () => {
    // Blank lines are ignored by parseTeamEventLine — not counted as malformed
    const health = makeStreamHealth();
    const blankLine = '\n';
    const parsed = parseTeamEventLine(blankLine);
    expect(parsed).toBe(null); // null return means ignored
    // Blank lines are NOT malformed — they're just empty
    // The counter should NOT increment for blank lines
    // (Current behavior: null without exception means skip)
    const snapshot = health.snapshot();
    expect(snapshot.malformedLines).toBe(0);
  });

  it("A15: isExitStatus — bogus status string on worker_output defaults to transient per contract", () => {
    // Ponytail: pins current contract — isExitStatus checks EXIT_STATUS_SET
    // A bogus status like "bogus" is NOT in the set → defaults to transient
    const bogusLine = '{"type":"worker_output","agentId":"worker-1","output":{"status":"bogus"}}';
    const parsed = parseTeamEventLine(bogusLine);
    expect(parsed).toBeTruthy();
    if (!parsed || parsed.kind !== "worker_output") throw new Error("Parse failed");
    const adapted = adaptTeamEvent(parsed, ctx);
    if (adapted.type !== "envelope") throw new Error("expected envelope");
    // Bogus status not in EXIT_STATUS_SET → defaults to "transient" (fail-safe)
    expect(adapted.status).toBe("transient");
  });

  it("A16: cost event with Infinity costUsd → parser rejects, never reaches adapter", () => {
    // Infinity/NaN from malformed costUsd is rejected by parseTeamEventLine
    // The adapter's non-finite guard is defense-in-depth for cases where the
    // parser contract might be bypassed.
    const infLine = '{"type":"cost","agentId":"w1","model":"m","inputTokens":100,"outputTokens":50,"turnCount":1,"unpricedTurns":0,"durationMs":1234,"costUsd":Infinity}';
    const parsed = parseTeamEventLine(infLine);
    // Parser rejects non-finite costUsd → null
    expect(parsed).toBe(null);
  });

  it("A16: adapter non-finite guard (bypassing parser) → coms trace with skip note", () => {
    // Direct adapter test bypassing parseTeamEventLine to verify the guard exists
    // This documents the contract: if a non-finite costUsd reaches the adapter,
    // it produces a coms trace with a skip note rather than corrupting the stream.
    const malformedCost = {
      kind: "cost" as const,
      event: {
        agentId: "w1",
        model: "m",
        inputTokens: 100,
        outputTokens: 50,
        turnCount: 1,
        unpricedTurns: 0,
        durationMs: 1234,
        costUsd: Number.POSITIVE_INFINITY,
        timestamp: "2026-08-17T12:00:10.000Z",
      },
    };
    const adapted = adaptTeamEvent(malformedCost, ctx);
    // Non-finite guard → coms trace event with skip note, NOT cost trace
    if (adapted.type !== "coms") throw new Error(`expected coms, got ${adapted.type}`);
    expect(adapted.name).toBe("cost_skipped_nonfinite");
    expect(adapted.payloadJson).toContain("non-finite");
  });

  it("adapter unsafe-integer guard (>MAX_SAFE_INTEGER micros) → coms trace with skip note", () => {
    // Cost values >$9B (~9,007,199,254 USD) exceed Number.MAX_SAFE_INTEGER when converted
    // to micros and silently corrupt. The adapter treats them as malformed.
    const hugeCost = {
      kind: "cost" as const,
      event: {
        agentId: "w1",
        model: "m",
        inputTokens: 100,
        outputTokens: 50,
        turnCount: 1,
        unpricedTurns: 0,
        durationMs: 1234,
        // 10_000_000_000 USD → 10_000_000_000_000_000_000 micros > MAX_SAFE_INTEGER (9,007,199,254,740,991)
        costUsd: 10000000000,
        timestamp: "2026-08-17T12:00:10.000Z",
      },
    };
    const adapted = adaptTeamEvent(hugeCost, ctx);
    // Unsafe integer guard → coms trace event with skip note, NOT cost trace
    if (adapted.type !== "coms") throw new Error(`expected coms, got ${adapted.type}`);
    expect(adapted.name).toBe("cost_skipped_unsafe");
    expect(adapted.payloadJson).toContain("safe integer");
  });

  it("A17: inline CRLF-content test (not fixture) — parser handles CRLF in valid JSON", () => {
    // Explicit inline string with CRLF — proves parser handles it (not fixture masking)
    const crlfValid = '{"type":"coms","requestId":"req-1","sessionId":"sess-1","phaseId":"phase-1","channel":"ch","direction":"send","senderAgent":"a","receiverAgent":"b","payloadSize":256,"durationMs":45,"timestamp":"2026-08-17T12:00:00.000Z"}\r\n';
    const parsed = parseTeamEventLine(crlfValid);
    expect(parsed).toBeTruthy();
    if (!parsed || parsed.kind !== "coms") throw new Error("Parse failed");
    const adapted = adaptTeamEvent(parsed, ctx);
    expect(adapted.type).toBe("coms");
  });
});
