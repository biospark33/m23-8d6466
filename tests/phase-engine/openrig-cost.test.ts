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
  const result = parseSeatSessionJsonl([line1, line2, line3, line4].join("\n"), "worker", "dev-worker@spike");
  expect(result).toMatchObject({ seat: "worker", sessionName: "dev-worker@spike" });
  // The two skipped lines (usage-less, unparsable) are counted, not dropped silently.
  expect(result.unpricedTurns).toBe(2);
  expect(result.usages).toHaveLength(2);
  expect(result.usages[0]).toEqual({
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

test("a NEGATIVE usage.cost is unpriced, never summed (provider artifact, not spend)", () => {
  const negative = JSON.stringify({
    role: "assistant",
    model: "deepseek/deepseek-v3.2",
    timestamp: "2026-09-23T18:02:00.000Z",
    usage: { cost: -0.5, input: 10, output: 2, cacheRead: 0, cacheWrite: 0 },
  });
  const result = parseSeatSessionJsonl(negative, "worker", "dev-worker@spike");
  expect(result.usages).toHaveLength(0);
  expect(result.unpricedTurns).toBe(1);
});

test("empty file parses to no rows", () => {
  const result = parseSeatSessionJsonl("", "lead", "dev-lead@spike");
  expect(result.usages).toHaveLength(0);
  expect(result.unpricedTurns).toBe(0);
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
  // line1 (priced), a usage-less line, line4 (priced): 2 usages, 1 unpriced.
  const result = parseSeatSessionJsonl(
    [line1, line2, line4].join("\n"),
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
