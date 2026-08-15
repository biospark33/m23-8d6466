/**
 * Usage accumulation: spend vs occupancy (Story DF1.3).
 *
 * The asymmetry this module exists to get right (R4 §1.10,
 * `MOD/agents.py:106-108`): every send costs, so usage ACCUMULATES across all
 * sends of a phase; every send continues the same context, so only the LAST
 * send's occupancy is current. Implemented as a merged `UsageBreakdown`
 * accumulator versus an overwritten `latest` occupancy pointer, read once at
 * phase end.
 *
 * Unit boundary (DD-9, INV-3): integer µ$ is the phase-engine's only cost
 * unit. The accumulator, `PhaseAttemptRecord`, the `agent_end` payload and
 * every persisted field are µ$ integers — no USD float exists anywhere inside
 * `src/phase-engine/`. The single micros-to-USD division lives in
 * `usdFromMicros` below and is applied once, on the way out to the runner's
 * budget guard. Nothing converts back, no intermediate rounds, and no µ$ value
 * is compared against a USD threshold without passing through this one site.
 */
import type { GateCheck } from "./gates/report.ts";

/**
 * One send's usage as reported by the sender, in the shape pi's turn usage
 * block reports (DF2.7: camelCase `cacheReadTokens`/`cacheWriteTokens`).
 *
 * Semantics preserved from R4 §1.10:
 *  - `inputTokens` EXCLUDES cache reads (they bill at their own cheaper rate).
 *  - `reasoningTokens` is the thinking share of OUTPUT — never a fifth
 *    component; it is nested under output here and never added to a total.
 *  - `costMicros` is integer µ$ (DD-9).
 */
export interface SendUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  costMicros: number;
}

/** Phase-total spend: the field-wise merge of every send's `SendUsage`. */
export interface UsageBreakdown {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  /** Integer µ$ — the phase-engine's only cost unit (DD-9). */
  costMicros: number;
  sends: number;
}

/**
 * The ONE phase-engine → runner boundary conversion (INV-3). The pre-existing
 * budget guard compares USD floats, so exactly this function — and nothing
 * else inside the engine — divides by a million. A µ$ integer read as USD is a
 * 10⁶× budget-guard failure, not a display bug.
 */
export function usdFromMicros(micros: number): number {
  return micros / 1_000_000;
}

function assertFiniteCount(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new UsageIntegrityError(`usage field '${name}' must be a non-negative integer, got ${value}`);
  }
}

/**
 * A sender reported usage that cannot be true (negative/NaN/∞/fractional
 * counts). Typed so DF1.6's dispatch can classify it distinctly from the two
 * retry-exhaustion errors — underreporting spend is a containment failure
 * (INV-3), never a metrics bug to swallow.
 */
export class UsageIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageIntegrityError";
  }
}

/**
 * Monotonic across all sends of a phase (INV-3): a retried phase reports the
 * full multi-send spend, so the budget guards that read it see the true total.
 * Underreporting retry spend — by omission or by unit error — is a containment
 * failure, not a metrics bug.
 */
export class UsageAccumulator {
  readonly #spent: UsageBreakdown = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    costMicros: 0,
    sends: 0,
  };
  #latestContextTokens = 0;

  /**
   * Merges one send's usage into the phase total (always), and optionally
   * records that send's occupancy reading. A turn reporting
   * `stopReason: "aborted" | "error"` still PAID (its usage is merged) but its
   * occupancy is untrustworthy and must not overwrite a good reading.
   */
  add(
    usage: SendUsage,
    occupancy?: { stopReason?: string; contextTokens?: number },
  ): void {
    assertFiniteCount("inputTokens", usage.inputTokens);
    assertFiniteCount("outputTokens", usage.outputTokens);
    assertFiniteCount("cacheReadTokens", usage.cacheReadTokens ?? 0);
    assertFiniteCount("cacheWriteTokens", usage.cacheWriteTokens ?? 0);
    assertFiniteCount("reasoningTokens", usage.reasoningTokens ?? 0);
    assertFiniteCount("costMicros", usage.costMicros);
    this.#spent.inputTokens += usage.inputTokens;
    this.#spent.outputTokens += usage.outputTokens;
    this.#spent.cacheReadTokens += usage.cacheReadTokens ?? 0;
    this.#spent.cacheWriteTokens += usage.cacheWriteTokens ?? 0;
    this.#spent.reasoningTokens += usage.reasoningTokens ?? 0;
    this.#spent.costMicros += usage.costMicros;
    this.#spent.sends += 1;
    if (
      occupancy !== undefined &&
      occupancy.contextTokens !== undefined &&
      occupancy.stopReason !== "aborted" &&
      occupancy.stopReason !== "error"
    ) {
      assertFiniteCount("contextTokens", occupancy.contextTokens);
      this.#latestContextTokens = occupancy.contextTokens;
    }
  }

  /** Phase totals; a fresh copy every call so callers cannot mutate history. */
  get spent(): UsageBreakdown {
    return { ...this.#spent };
  }

  /**
   * Last good occupancy reading (0 until one is observed — 0 means *unknown*,
   * never *full*, so no bound may be derived from it).
   */
  get latestContextTokens(): number {
    return this.#latestContextTokens;
  }
}

// Re-exported so `agent_end` consumers can read the check shape without
// reaching into the gates module directly.
export type { GateCheck };
