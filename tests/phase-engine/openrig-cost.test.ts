/**
 * parseSeatSessionJsonl / emitSeatCosts unit tests. Fixtures encode pi
 * 0.84.4's REAL session JSONL shape (the S0 spike's assumed flat shape made
 * the parser price nothing on live rounds 19–21): every message is wrapped in
 * a typed entry `{type:"message", message, id, seq, parentId, timestamp}`,
 * Usage.cost is an OBJECT whose spend figure is `.total`, and `timestamp` is
 * entry-level Unix ms. Sources: badlogic/pi-mono v0.84.4
 * packages/agent/src/harness/session/types.ts (MessageEntry),
 * packages/ai/src/types.ts (Usage), packages/ai/src/api/openai-completions.ts
 * (calculateCost prices LOCALLY from registry rates).
 */
import { describe, expect, test } from "bun:test";

import { emitSeatCosts, parseSeatSessionJsonl } from "../../src/phase-engine/phases/openrig-cost.ts";

const TS_MS = Date.parse("2026-09-23T18:00:00.000Z");
let entryOrdinal = 0;

/** One pi session entry line: the wrapper every message ships inside. */
function entry(message: Record<string, unknown>, timestampMs: number = TS_MS): string {
  entryOrdinal += 1;
  return JSON.stringify({
    type: "message",
    id: `entry-${entryOrdinal}`,
    seq: entryOrdinal,
    parentId: null,
    timestamp: timestampMs,
    message,
  });
}

function assistant(costTotal: unknown, model = "deepseek/deepseek-v3.2"): Record<string, unknown> {
  return {
    role: "assistant",
    model,
    usage: {
      input: 1000,
      output: 200,
      cacheRead: 50,
      cacheWrite: 10,
      totalTokens: 1260,
      cost: { input: 0.01, output: 0.002, cacheRead: 0.0005, cacheWrite: 0, total: costTotal },
    },
  };
}

describe("parseSeatSessionJsonl (real pi 0.84.4 shape)", () => {
  test("prices assistant entries and skips non-turn entries (user, header, model-change)", () => {
    const text = [
      JSON.stringify({ type: "session", id: "s1", seq: 0, parentId: null, timestamp: TS_MS, path: "/x.jsonl" }),
      entry({ role: "user", content: [{ type: "text", text: "go" }] }),
      entry(assistant(0.0125)),
      JSON.stringify({ type: "model-change", id: "mc1", seq: 9, parentId: "e", timestamp: TS_MS, provider: "openrouter", modelId: "deepseek/deepseek-v3.2" }),
      entry({ role: "toolResult", toolCallId: "t1", toolName: "read", output: [{ type: "text", text: "ok" }] }),
    ].join("\n");
    const result = parseSeatSessionJsonl(text, "worker", "dev-worker@spike");
    // Only the assistant entry is a turn; nothing else counts as unpriced.
    expect(result.usages).toHaveLength(1);
    expect(result.unpricedTurns).toBe(0);
    expect(result.usages[0]).toMatchObject({
      seat: "worker",
      sessionName: "dev-worker@spike",
      model: "deepseek/deepseek-v3.2",
      costMicroUsd: 12_500, // Math.round(0.0125 * 1e6), DD-9 boundary
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadTokens: 50,
      cacheWriteTokens: 10,
      timestamp: "2026-09-23T18:00:00.000Z", // entry-level Unix ms → ISO
    });
  });

  test("an assistant entry whose cost.total is missing, non-number, or negative is unpriced", () => {
    const noTotal = assistant(undefined);
    const objectTotal = assistant({ total: 0.5 }); // nested object, not a number
    const negative = assistant(-0.5);
    const text = [entry(assistant(0.002)), entry(noTotal), entry(objectTotal), entry(negative)].join("\n");
    const result = parseSeatSessionJsonl(text, "worker", "dev-worker@spike");
    expect(result.usages).toHaveLength(1);
    expect(result.unpricedTurns).toBe(3);
  });

  test("an assistant entry with no usage object is unpriced", () => {
    const text = entry({ role: "assistant", model: "m", stopReason: "aborted" });
    const result = parseSeatSessionJsonl(text, "worker", "dev-worker@spike");
    expect(result.usages).toHaveLength(0);
    expect(result.unpricedTurns).toBe(1);
  });

  test("a torn tail line is unpriced, never thrown; empty file is 0/0", () => {
    const torn = parseSeatSessionJsonl(`${entry(assistant(0.002))}\n{"type":"message","mess`, "worker", "s");
    expect(torn.usages).toHaveLength(1);
    expect(torn.unpricedTurns).toBe(1);
    const empty = parseSeatSessionJsonl("", "lead", "s");
    expect(empty.usages).toHaveLength(0);
    expect(empty.unpricedTurns).toBe(0);
  });

  test("a non-string entry.timestamp prices fine but carries timestamp null", () => {
    const text = JSON.stringify({
      type: "message", id: "e", seq: 1, parentId: null, timestamp: "not-a-number",
      message: assistant(0.002),
    });
    const result = parseSeatSessionJsonl(text, "worker", "s");
    expect(result.usages).toHaveLength(1);
    expect(result.usages.at(0)?.timestamp).toBeNull();
  });
});

describe("emitSeatCosts", () => {
  test("emits one cost_attribution line per usage with the dispatch-task shape", () => {
    const seq = new Map<string, number>();
    const emitted: Record<string, unknown>[] = [];
    const text = [entry(assistant(0.0125), TS_MS), entry(assistant(0.002), TS_MS + 60_000)].join("\n");
    const total = emitSeatCosts(parseSeatSessionJsonl(text, "worker", "dev-worker@spike"), {
      emitMoneyLine: (l) => emitted.push(l),
      invocationSeqByAgent: seq,
      requestId: "req-1",
      runId: "run-1",
      phaseId: "ph-1",
      role: "worker",
    });
    expect(total).toBe(12_500 + 2_000);
    expect(emitted).toHaveLength(2);
    expect(emitted[0]).toMatchObject({
      type: "cost_attribution",
      requestId: "req-1",
      runId: "run-1",
      phaseId: "ph-1",
      agentId: "dev-worker@spike",
      role: "worker",
      invocationSeq: 0,
      model: "deepseek/deepseek-v3.2",
      costMicroUsd: 12_500,
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadTokens: 50,
      cacheWriteTokens: 10,
      turnCount: 1,
      unpricedTurns: 0,
      timestamp: "2026-09-23T18:00:00.000Z",
    });
    // second line from the SAME agent advances the run-scoped ordinal (INV-COST-8)
    expect(emitted[1]).toMatchObject({ invocationSeq: 1 });
    expect(seq.get("dev-worker@spike")).toBe(2);
  });

  test("emitSeatCosts returns 0 for an empty seat", () => {
    const emitted: Record<string, unknown>[] = [];
    const total = emitSeatCosts(
      { seat: "lead", sessionName: "dev-lead@spike", usages: [], unpricedTurns: 0 },
      {
        emitMoneyLine: (l) => emitted.push(l),
        requestId: "r", runId: "run", phaseId: "p", role: "lead",
      },
    );
    expect(total).toBe(0);
    expect(emitted).toHaveLength(0); // a silent seat emits nothing
  });

  test("a seat that spoke but priced nothing emits ONE zero-µ$ row carrying its unpricedTurns", () => {
    const emitted: Record<string, unknown>[] = [];
    const total = emitSeatCosts(
      { seat: "worker", sessionName: "dev-worker@spike", usages: [], unpricedTurns: 3 },
      {
        emitMoneyLine: (l) => emitted.push(l),
        requestId: "r", runId: "run", phaseId: "p", role: "worker",
      },
    );
    expect(total).toBe(0);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      type: "cost_attribution",
      agentId: "dev-worker@spike",
      costMicroUsd: 0,
      turnCount: 0,
      unpricedTurns: 3,
      model: null,
    });
  });

  test("the seat's unpricedTurns ride the FIRST emitted row only", () => {
    // priced, torn (unpriced), priced: 2 usages, 1 unpriced.
    const result = parseSeatSessionJsonl(
      [entry(assistant(0.0125)), '{"type":"mess', entry(assistant(0.002))].join("\n"),
      "worker",
      "dev-worker@spike",
    );
    expect(result.usages).toHaveLength(2);
    expect(result.unpricedTurns).toBe(1);
    const emitted: Record<string, unknown>[] = [];
    emitSeatCosts(result, {
      emitMoneyLine: (l) => emitted.push(l),
      requestId: "r", runId: "run", phaseId: "p", role: "worker",
    });
    expect(emitted).toHaveLength(2);
    expect(emitted[0]).toMatchObject({ unpricedTurns: 1 });
    expect(emitted[1]).toMatchObject({ unpricedTurns: 0 });
  });

  test("consecutive usage-less emissions advance the per-agent ordinal (rotated JSONLs cannot collide on seq 0)", () => {
    // The caller emits per rotated JSONL file: two usage-less files for one
    // seat must produce two rows with DISTINCT invocationSeq values, not two
    // rows both claiming the seat's first ordinal.
    const seq = new Map<string, number>();
    const emitted: Record<string, unknown>[] = [];
    const deps = {
      emitMoneyLine: (l: Record<string, unknown>) => emitted.push(l),
      invocationSeqByAgent: seq,
      requestId: "r", runId: "run", phaseId: "p", role: "worker",
    };
    const seat = { seat: "worker", sessionName: "dev-worker@spike", usages: [], unpricedTurns: 2 };
    emitSeatCosts(seat, deps);
    emitSeatCosts(seat, deps);
    expect(emitted).toHaveLength(2);
    expect(emitted[0]).toMatchObject({ agentId: "dev-worker@spike", invocationSeq: 0 });
    expect(emitted[1]).toMatchObject({ agentId: "dev-worker@spike", invocationSeq: 1 });
    expect(seq.get("dev-worker@spike")).toBe(2);
  });
});
