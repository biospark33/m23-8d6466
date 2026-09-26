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
   * Assistant turns consumed but NOT priced: torn/unparsable lines and
   * assistant entries whose usage is missing or whose cost.total is missing,
   * non-numeric, or negative (a negative cost is a provider artifact, never
   * spend — skipped, not summed). Non-assistant entries (user, toolResult)
   * and non-message entries (session header, model-change) are NOT turns:
   * they make no provider call and never reach this count.
   */
  unpricedTurns: number;
}

/**
 * Parse one seat's session JSONL — pi 0.84.4's REAL shape, verified against
 * upstream source after live rounds 19–21 priced ZERO rows out of 81 (the S0
 * spike's assumed flat shape — `{role, model, usage: {cost: <number>}}` at
 * the top level — matches nothing pi writes):
 *
 * - every message ships wrapped: `{type:"message", message, id, seq,
 *   parentId, timestamp}` (pi-mono `packages/agent/src/harness/session/
 *   types.ts`, MessageEntry); session headers, model-change entries and
 *   anything else are non-message entries, not turns;
 * - `Usage.cost` is an OBJECT `{input, output, cacheRead, cacheWrite,
 *   total}` — the spend figure is `.total`, never a bare number (pi-mono
 *   `packages/ai/src/types.ts`);
 * - pi prices LOCALLY from its registry's model rates (`calculateCost` in
 *   `packages/ai/src/api/openai-completions.ts`); the API's returned cost is
 *   not consumed — so under AC5's empty in-box registry every turn prices
 *   legitimately at `total: 0` (a priced zero, NOT unpriced);
 * - `model` lives on the message, `timestamp` is entry-level Unix ms.
 *
 * Tolerant by design: a torn tail line is a crash artifact, not a parse
 * error — it and any unpriceable assistant turn land in `unpricedTurns`,
 * never thrown.
 */
export function parseSeatSessionJsonl(text: string, seat: string, sessionName: string): SeatParseResult {
  const usages: SeatUsage[] = [];
  let unpricedTurns = 0;
  const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue; // a trailing newline is not a turn
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      unpricedTurns += 1;
      continue;
    }
    if (typeof entry !== "object" || entry === null) {
      unpricedTurns += 1;
      continue;
    }
    if ((entry as { type?: unknown }).type !== "message") continue; // header / model-change / custom: not a turn
    const message = (entry as { message?: unknown }).message;
    if (typeof message !== "object" || message === null) {
      unpricedTurns += 1;
      continue;
    }
    const r = message as Record<string, unknown>;
    if (r.role !== "assistant") continue; // user/toolResult entries make no provider call
    const usage = r.usage;
    if (typeof usage !== "object" || usage === null) {
      unpricedTurns += 1;
      continue;
    }
    const costObj = (usage as { cost?: unknown }).cost;
    const total = typeof costObj === "object" && costObj !== null ? (costObj as { total?: unknown }).total : undefined;
    if (typeof total !== "number" || !Number.isFinite(total) || total < 0) {
      unpricedTurns += 1;
      continue;
    }
    const u = usage as Record<string, unknown>;
    const ts = (entry as { timestamp?: unknown }).timestamp;
    usages.push({
      seat,
      sessionName,
      model: typeof r.model === "string" ? r.model : null,
      costMicroUsd: usdToMicros(total),
      inputTokens: n(u.input),
      outputTokens: n(u.output),
      cacheReadTokens: n(u.cacheRead),
      cacheWriteTokens: n(u.cacheWrite),
      timestamp: typeof ts === "number" && Number.isFinite(ts) ? new Date(ts).toISOString() : null,
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
