/**
 * Seat session JSONL → cost_attribution money lines. S1 of the rig_swarm
 * integration — per-seat cost evidence must reach the ledger or teardown
 * flags the run `unwired` (teardown.ts reportSpendDivergence).
 */
import { usdToMicros } from "../../providers/credentials.ts";

/** One priced assistant message from a seat's pi session JSONL (µ$ ints, DD-9). */
export interface SeatUsage {
  seat: string;
  sessionName: string;
  model: string | null;
  costMicroUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  timestamp: string | null;
}

/** One seat's parsed JSONL: the priced rows plus the turns that were not. */
export interface SeatParseResult {
  seat: string;
  sessionName: string;
  usages: SeatUsage[];
  /**
   * Lines consumed but NOT priced: unparsable, usage-less, or negative-cost
   * (a negative cost is a provider artifact, never spend — skipped, not summed).
   */
  unpricedTurns: number;
}

/**
 * Parse one seat's session JSONL. Tolerant by design: pi writes role/user
 * lines and assistant lines without usage between priced ones, and a torn
 * tail line is a crash artifact, not a parse error — each unparsable or
 * usage-less line is skipped into `unpricedTurns`, never thrown.
 */
export function parseSeatSessionJsonl(text: string, seat: string, sessionName: string): SeatParseResult {
  const usages: SeatUsage[] = [];
  let unpricedTurns = 0;
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue; // a trailing newline is not a turn
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      unpricedTurns += 1;
      continue;
    }
    if (typeof row !== "object" || row === null) {
      unpricedTurns += 1;
      continue;
    }
    const usage = (row as { usage?: unknown }).usage;
    if (typeof usage !== "object" || usage === null) {
      unpricedTurns += 1;
      continue;
    }
    const cost = (usage as { cost?: unknown }).cost;
    if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0) {
      unpricedTurns += 1;
      continue;
    }
    const u = usage as Record<string, unknown>;
    const r = row as Record<string, unknown>;
    const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
    usages.push({
      seat,
      sessionName,
      model: typeof r.model === "string" ? r.model : null,
      costMicroUsd: usdToMicros(cost),
      inputTokens: n(u.input),
      outputTokens: n(u.output),
      cacheReadTokens: n(u.cacheRead),
      cacheWriteTokens: n(u.cacheWrite),
      timestamp: typeof r.timestamp === "string" ? r.timestamp : null,
    });
  }
  return { seat, sessionName, usages, unpricedTurns };
}

/**
 * Emit the DF2.12 cost_attribution lines for one seat's usage, in file order.
 * `agentId` is the OpenRig session name (the seat's identity in the swarm);
 * `role` is the rigSpec member id. The line shape is byte-compatible with
 * dispatch-task.ts's emitMoney call (INV-COST-8 fields included) so the host
 * bridge and ledger treat both engines identically. Each row is exactly one
 * consumed priced line (`turnCount: 1`); the seat's unpriced turns ride the
 * FIRST row (`unpricedTurns`, 0 on the rest) so per-seat ledger totals are
 * truthful without a synthetic row. Returns the seat's total µ$ so the caller
 * can log it alongside the teardown.
 */
export function emitSeatCosts(
  result: SeatParseResult,
  deps: {
    emitMoneyLine: (line: Record<string, unknown>) => void;
    invocationSeqByAgent?: Map<string, number>;
    requestId: string;
    runId: string;
    phaseId: string;
    role: string;
  },
): number {
  const seq = deps.invocationSeqByAgent ?? new Map<string, number>();
  let total = 0;
  result.usages.forEach((u, i) => {
    const invocationSeq = seq.get(u.sessionName) ?? 0;
    seq.set(u.sessionName, invocationSeq + 1);
    deps.emitMoneyLine({
      type: "cost_attribution",
      requestId: deps.requestId,
      runId: deps.runId,
      phaseId: deps.phaseId,
      agentId: u.sessionName,
      role: deps.role,
      invocationSeq,
      model: u.model,
      costMicroUsd: u.costMicroUsd,
      inputTokens: u.inputTokens,
      outputTokens: u.outputTokens,
      cacheReadTokens: u.cacheReadTokens,
      cacheWriteTokens: u.cacheWriteTokens,
      turnCount: 1,
      unpricedTurns: i === 0 ? result.unpricedTurns : 0,
      timestamp: u.timestamp,
    });
    total += u.costMicroUsd;
  });
  if (result.usages.length === 0 && result.unpricedTurns > 0) {
    // The seat spoke but priced nothing — a zero-µ$ row keeps the unpriced
    // count on the ledger (INV-COST-8: evidence, never silently dropped).
    // The per-agent ordinal advances here too: the caller emits per rotated
    // JSONL file, so a seat whose second file is also usage-less must not
    // emit a second row claiming the same invocationSeq as the first.
    const invocationSeq = seq.get(result.sessionName) ?? 0;
    seq.set(result.sessionName, invocationSeq + 1);
    deps.emitMoneyLine({
      type: "cost_attribution",
      requestId: deps.requestId,
      runId: deps.runId,
      phaseId: deps.phaseId,
      agentId: result.sessionName,
      role: deps.role,
      invocationSeq,
      model: null,
      costMicroUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      turnCount: 0,
      unpricedTurns: result.unpricedTurns,
      timestamp: null,
    });
  }
  return total;
}
