/**
 * DF4.2 unit tests for src/lib/events.ts (AC1).
 */
import { describe, expect, test } from "bun:test";
import {
  EVENT_DOT_COLORS,
  dotColor,
  AGENT_FALLBACK_COLORS,
  agentColor,
  hexAlpha,
  parsePayload,
  parseToolCall,
  parseAgentStart,
  argsSummary,
  eventLabel,
} from "../../src/lib/events.ts";
import type { EventRow } from "../../src/lib/types.ts";

function row(overrides: Partial<EventRow>): EventRow {
  return {
    rowid: 1,
    event_id: "ev-1",
    request_id: "req-1",
    phase_id: null,
    parent_id: null,
    type: null,
    name: null,
    payload_json: null,
    tokens: null,
    started_at: null,
    ended_at: null,
    ...overrides,
  };
}

describe("dotColor", () => {
  test("null type → no color", () => {
    expect(dotColor(null)).toBeNull();
  });

  test("known type looks up EVENT_DOT_COLORS", () => {
    expect(dotColor("agent_start")).toBe(EVENT_DOT_COLORS.agent_start ?? null);
    expect(dotColor("gate_fail")).toBe("#ff6f67");
  });

  test("unknown type → no color", () => {
    expect(dotColor("unknown_type")).toBeNull();
  });
});

describe("agentColor", () => {
  test("config color wins over everything", () => {
    expect(agentColor("#111111", "#222222", 0)).toBe("#111111");
  });

  test("payload color wins when config is absent", () => {
    expect(agentColor(null, "#222222", 0)).toBe("#222222");
    expect(agentColor(undefined, "#222222", 0)).toBe("#222222");
  });

  test("falls back to the palette by index when both are absent", () => {
    expect(agentColor(null, null, 0)).toBe(AGENT_FALLBACK_COLORS[0] as string);
    expect(agentColor(null, null, 1)).toBe(AGENT_FALLBACK_COLORS[1] as string);
  });

  test("palette index wraps modulo the palette length", () => {
    const wrapped = AGENT_FALLBACK_COLORS.length;
    expect(agentColor(null, null, wrapped)).toBe(AGENT_FALLBACK_COLORS[0] as string);
  });
});

describe("hexAlpha", () => {
  test("converts a 6-digit hex to rgba with the given alpha", () => {
    expect(hexAlpha("#c89bff", 0.5)).toBe("rgba(200, 155, 255, 0.5)");
  });

  test("accepts a hex string without the leading #, and trims whitespace", () => {
    expect(hexAlpha(" c89bff ", 1)).toBe("rgba(200, 155, 255, 1)");
  });

  test("is case-insensitive", () => {
    expect(hexAlpha("#C89BFF", 1)).toBe("rgba(200, 155, 255, 1)");
  });

  test("invalid input → transparent", () => {
    expect(hexAlpha("not-a-hex", 1)).toBe("transparent");
    expect(hexAlpha("#fff", 1)).toBe("transparent"); // 3-digit shorthand unsupported
  });
});

describe("parsePayload", () => {
  test("null/undefined/empty → null", () => {
    expect(parsePayload(null)).toBeNull();
    expect(parsePayload(undefined)).toBeNull();
    expect(parsePayload("")).toBeNull();
  });

  test("valid JSON object → parsed record", () => {
    expect(parsePayload('{"a":1}')).toEqual({ a: 1 });
  });

  test("a JSON array is not an object payload → null", () => {
    expect(parsePayload("[1,2,3]")).toBeNull();
  });

  test("malformed JSON → null", () => {
    expect(parsePayload("not json")).toBeNull();
  });
});

describe("parseToolCall", () => {
  test("a payload with a string tool field parses as a ToolCallPayload", () => {
    const e = row({ payload_json: '{"tool":"bash","args":{"command":"ls"}}' });
    expect(parseToolCall(e)).toEqual({ tool: "bash", args: { command: "ls" } });
  });

  test("a payload missing tool, or tool not a string, → null", () => {
    expect(parseToolCall(row({ payload_json: '{"args":{}}' }))).toBeNull();
    expect(parseToolCall(row({ payload_json: '{"tool":1}' }))).toBeNull();
  });

  test("no payload → null", () => {
    expect(parseToolCall(row({ payload_json: null }))).toBeNull();
  });
});

describe("parseAgentStart", () => {
  test("parses whatever object shape is present, no field required", () => {
    const e = row({ payload_json: '{"model":"claude-opus-5"}' });
    expect(parseAgentStart(e)).toEqual({ model: "claude-opus-5" });
  });

  test("no payload → null", () => {
    expect(parseAgentStart(row({ payload_json: null }))).toBeNull();
  });
});

describe("argsSummary", () => {
  test("undefined args → empty string", () => {
    expect(argsSummary(undefined)).toBe("");
  });

  test("prefers the highest-priority label key present", () => {
    expect(argsSummary({ file_path: "/a.ts", command: "ls -la" })).toBe("ls -la");
  });

  test("falls through to a lower-priority key when a higher one is absent or blank", () => {
    expect(argsSummary({ command: "  ", file_path: "/a.ts" })).toBe("/a.ts");
  });

  test("no priority key present → key=value pairs joined, string values written bare and non-strings JSON-stringified", () => {
    const out = argsSummary({ foo: 1, bar: "x" });
    expect(out).toBe("foo=1 bar=x");
  });

  test("null-valued keys are skipped in the fallback join", () => {
    expect(argsSummary({ foo: null, bar: "x" })).toBe("bar=x");
  });

  test("collapses internal whitespace and truncates past the label max", () => {
    const long = "x".repeat(200);
    const out = argsSummary({ command: long });
    expect(out.length).toBe(161); // 160 chars + the ellipsis
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("eventLabel", () => {
  test("a rich tool_call whose event name already carries the tool prefix is used verbatim", () => {
    const e = row({
      type: "tool_call",
      name: "bash: ls -la src",
      payload_json: '{"tool":"bash"}',
    });
    expect(eventLabel(e)).toBe("bash: ls -la src");
  });

  test("a rich tool_call without a matching name derives 'tool: summary'", () => {
    const e = row({
      type: "tool_call",
      name: "something-else",
      payload_json: '{"tool":"bash","args":{"command":"ls -la"}}',
    });
    expect(eventLabel(e)).toBe("bash: ls -la");
  });

  test("a rich tool_call with no summarizable args falls back to the bare tool name", () => {
    const e = row({ type: "tool_call", payload_json: '{"tool":"bash","args":{}}' });
    expect(eventLabel(e)).toBe("bash");
  });

  test("a legacy tool_call payload (pi_event, no tool field) uses name + pi_event", () => {
    const e = row({ type: "tool_call", name: "legacy", payload_json: '{"pi_event":"call"}' });
    expect(eventLabel(e)).toBe("legacy call");
  });

  test("a legacy tool_call with no name falls back to 'tool'", () => {
    const e = row({ type: "tool_call", name: null, payload_json: '{"pi_event":"call"}' });
    expect(eventLabel(e)).toBe("tool call");
  });

  test("a non-tool_call event falls back to name, then type, then empty string", () => {
    expect(eventLabel(row({ type: "agent_start", name: "agent-1" }))).toBe("agent-1");
    expect(eventLabel(row({ type: "agent_start", name: null }))).toBe("agent_start");
    expect(eventLabel(row({ type: null, name: null }))).toBe("");
  });
});
