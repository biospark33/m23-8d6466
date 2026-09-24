import { expect, test } from "bun:test";
import { emitSeatCosts, parseSeatSessionJsonl } from "../../src/phase-engine/phases/openrig-cost.ts";

const line1 = JSON.stringify({
  role: "assistant",
  model: "deepseek/deepseek-v3.2",
  timestamp: "2026-09-23T18:00:00.000Z",
  usage: { cost: 0.0125, input: 1000, output: 200, cacheRead: 50, cacheWrite: 10 },
});
const line2 = JSON.stringify({
  role: "user",
  content: "no usage here",
});
const line3 = "not json at all";
const line4 = JSON.stringify({
  role: "assistant",
  model: "deepseek/deepseek-v3.2",
  timestamp: "2026-09-23T18:01:00.000Z",
  usage: { cost: 0.002, input: 100, output: 20, cacheRead: 0, cacheWrite: 0 },
});

test("parseSeatSessionJsonl keeps only messages carrying usage.cost", () => {
  const rows = parseSeatSessionJsonl([line1, line2, line3, line4].join("\n"), "worker", "dev-worker@spike");
  expect(rows).toHaveLength(2);
  expect(rows[0]).toEqual({
    seat: "worker",
    sessionName: "dev-worker@spike",
    model: "deepseek/deepseek-v3.2",
    costMicroUsd: 12_500, // Math.round(0.0125 * 1e6), DD-9 boundary
    inputTokens: 1000,
    outputTokens: 200,
    cacheReadTokens: 50,
    cacheWriteTokens: 10,
    timestamp: "2026-09-23T18:00:00.000Z",
  });
});

test("empty file parses to no rows", () => {
  expect(parseSeatSessionJsonl("", "lead", "dev-lead@spike")).toHaveLength(0);
});

test("emitSeatCosts emits one cost_attribution line per usage with the dispatch-task shape", () => {
  const seq = new Map<string, number>();
  const emitted: Record<string, unknown>[] = [];
  const total = emitSeatCosts(parseSeatSessionJsonl([line1, line4].join("\n"), "worker", "dev-worker@spike"), {
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
  const total = emitSeatCosts([], {
    emitMoneyLine: () => {},
    requestId: "r", runId: "run", phaseId: "p", role: "lead",
  });
  expect(total).toBe(0);
});
