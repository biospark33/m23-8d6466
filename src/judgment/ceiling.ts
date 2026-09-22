/**
 * Stage-ceiling circuit breaker (JEV-2, handoff §3.2 — infrastructure tier).
 *
 * A stage is ONE JudgmentCeiling instance held by the caller for the stage's
 * process lifetime; the cumulative counter is in-memory (a per-process
 * breaker — acceptable for batch workloads). It is a runaway-loop circuit
 * breaker, NOT cost control: no per-run budget admission, no
 * `extensions.budget` interaction, no provider-layer call anywhere.
 *
 * Shipped default 1,000,000 cumulative request input tokens per stage
 * (≈ $0.042 at the vendor's input-only $0.042/Mtok rate).
 */

export const DEFAULT_STAGE_CEILING_INPUT_TOKENS = 1_000_000;

export class CeilingExceededError extends Error {
  constructor(
    public readonly observed: number,
    public readonly ceiling: number,
  ) {
    super(
      `stage ceiling exceeded: observed ${observed.toLocaleString("en-US")} cumulative input tokens vs ceiling ${ceiling.toLocaleString(
        "en-US",
      )} — further judgment calls in this stage are refused (handoff §3.2 circuit breaker)`,
    );
    this.name = "CeilingExceededError";
  }
}

export class JudgmentCeiling {
  private used = 0;

  constructor(public readonly ceiling: number = DEFAULT_STAGE_CEILING_INPUT_TOKENS) {}

  /** Cumulative observed input tokens recorded in this stage so far. */
  get observedInputTokens(): number {
    return this.used;
  }

  /**
   * Consult before a judgment call: refuses (typed, in-stage) once the
   * cumulative OBSERVED usage has crossed the ceiling. A call in flight is
   * never retroactively refused — the breaker stops the NEXT one, exactly
   * the AC-5 semantics.
   */
  admit(): void {
    if (this.used >= this.ceiling) throw new CeilingExceededError(this.used, this.ceiling);
  }

  /** Record a completed call's observed input tokens. */
  record(inputTokens: number): void {
    this.used += inputTokens;
  }
}
