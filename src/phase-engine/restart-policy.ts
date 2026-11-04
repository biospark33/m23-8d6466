/**
 * P1.9 — the cross-run restart policy: caps, the decision function, and the
 * bounded retry executor.
 *
 * Classification (signal → class) lives in `failure-signal.ts`; this module
 * answers the policy question — may this step run again, after how long, and
 * what is left of its budget — and provides `runWithRestart`, the one executor
 * any caller (fleet dispatcher, fix loop, a future cross-run driver) wraps a
 * fallible step in. The phase engine itself stays single-attempt per `Run`
 * (DF1.10: systemd `Restart=no`, reclaim is DF1.10's); cross-run retries
 * belong to whoever drives runs, which is exactly the seam this executor is.
 *
 * INV-RESTART-1: caps are enforced atomically inside `evaluateRestart` before
 * any retry — a step can never see a 9th retry or run past 1h of wall clock,
 * whatever the caller does.
 *
 * Backoff: 2s initial, doubling, saturating at 60s (AC2). Overflow retries
 * immediately with `reducedScope` (AC: retry with reduced scope); logic never
 * retries (AC3). A cap refusal names itself: `reason: "cap-exceeded"` (AC4).
 */
import { z } from "zod";

import { classifyFailure, type FailureClass, type FailureSignal } from "./failure-signal.ts";

export const RestartCapsSchema = z
  .strictObject({
    maxRetries: z.number().int().min(1).max(64),
    maxWallClockMs: z.number().int().positive(),
  })
  .strict();

export type RestartCaps = z.infer<typeof RestartCapsSchema>;

/** Spec caps: ≤8 retries per step, ≤1 hour wall-clock per step (INV-RESTART-1). */
export const DEFAULT_RESTART_CAPS: RestartCaps = { maxRetries: 8, maxWallClockMs: 3_600_000 };

export const INITIAL_BACKOFF_MS = 2_000;
export const MAX_BACKOFF_MS = 60_000;

export const RestartDecisionSchema = z
  .strictObject({
    class: z.enum(["transient", "overflow", "logic"]),
    shouldRetry: z.boolean(),
    /** Absent = retry immediately (overflow's reduced-scope retry). */
    nextBackoffMs: z.number().int().positive().optional(),
    /** True when the retry must come back with a smaller scope (overflow). */
    reducedScope: z.boolean().optional(),
    retriesRemaining: z.number().int().nonnegative(),
    wallClockRemainingMs: z.number().int().nonnegative(),
    /** Set exactly when a retry is refused because a cap is already spent. */
    reason: z.literal("cap-exceeded").optional(),
  })
  .strict();

export type RestartDecision = z.infer<typeof RestartDecisionSchema>;

export interface EvaluateRestartInput {
  /** Explicit classification seam — the phase engine's own precedence-classified verdict wins over the signal when both exist. */
  class?: FailureClass;
  retriesUsed: number;
  wallClockMs: number;
  caps?: RestartCaps;
}

/**
 * Pure decision function (INV-RESTART-2: no clock reads — the caller passes
 * the wall clock it observed; passing `now`/`sleep` seams instead of reading
 * time directly is what keeps this testable and deterministic).
 */
export function evaluateRestart(signal: FailureSignal, input: EvaluateRestartInput): RestartDecision {
  // INV-RESTART-1 hardening: caps may be TIGHTENED by the caller, never
  // loosened — the documented ceiling (8 retries / 1h wall-clock) is the
  // policy, so a larger request clamps down to it.
  const requested = input.caps ?? DEFAULT_RESTART_CAPS;
  const caps: RestartCaps = {
    maxRetries: Math.min(Math.max(1, Math.floor(requested.maxRetries) || 1), DEFAULT_RESTART_CAPS.maxRetries),
    maxWallClockMs: Math.min(
      Math.max(1, Math.floor(requested.maxWallClockMs) || 1),
      DEFAULT_RESTART_CAPS.maxWallClockMs,
    ),
  };
  const cls = input.class ?? classifyFailure(signal);
  // Non-finite accounting (NaN/±Infinity from a hostile caller or a broken
  // injected clock — e.g. Infinity - Infinity) fails CLOSED: the decision is
  // a cap refusal, never a retry with NaN backoff.
  if (!Number.isFinite(input.retriesUsed) || !Number.isFinite(input.wallClockMs)) {
    return { class: cls, shouldRetry: false, retriesRemaining: 0, wallClockRemainingMs: 0, reason: "cap-exceeded" };
  }
  // Clamp the caller-supplied accounting (INV-RESTART-1 hardening): a negative
  // or fractional retriesUsed would push `retriesRemaining` past the cap and
  // make the backoff exponent fractional (violating RestartDecisionSchema);
  // a negative wallClockMs (non-monotonic clock jump) would report remaining
  // time above the cap. Neither is reachable through runWithRestart, whose own
  // accounting is monotonic and integral — this guards direct callers.
  const used = Math.max(0, Math.floor(input.retriesUsed));
  const elapsed = Math.max(0, Math.floor(input.wallClockMs));
  const retriesRemaining = Math.max(0, Math.min(caps.maxRetries - used, caps.maxRetries));
  const wallClockRemainingMs = Math.max(0, Math.min(caps.maxWallClockMs - elapsed, caps.maxWallClockMs));
  const base: RestartDecision = {
    class: cls,
    shouldRetry: false,
    retriesRemaining,
    wallClockRemainingMs,
  };
  if (cls === "logic") return base;
  if (retriesRemaining <= 0 || wallClockRemainingMs <= 0) return { ...base, reason: "cap-exceeded" };
  if (cls === "overflow") {
    return { ...base, shouldRetry: true, reducedScope: true };
  }
  // transient: exponential backoff, 2s doubling, saturated at 60s. `used`
  // retries have already happened, so the NEXT wait is 2s × 2^used. A wait
  // that would land the next attempt past the wall-clock cap is a refusal —
  // the cap binds on when the attempt STARTS, not on when the decision was
  // made (INV-RESTART-1: never past 1h, with no backoff-overshoot allowance).
  const backoff = Math.min(INITIAL_BACKOFF_MS * 2 ** used, MAX_BACKOFF_MS);
  if (wallClockRemainingMs <= backoff) return { ...base, reason: "cap-exceeded" };
  return { ...base, shouldRetry: true, nextBackoffMs: backoff };
}

// ─── runWithRestart — the bounded retry executor ────────────────────────────

/** How a step hands its failure signal to the executor: a property on the thrown error. */
export const FAILURE_SIGNAL_PROPERTY = "failureSignal";

/** Structured events the executor emits — the audit trail (INV-RESTART-3). */
export type RestartEvent =
  | { event: "restart_classification"; runId: string; stepId: string; attempt: number; class: FailureClass; signal: FailureSignal }
  | { event: "restart_decision"; runId: string; stepId: string; attempt: number; decision: RestartDecision }
  | { event: "restart_succeeded"; runId: string; stepId: string; attempt: number }
  | { event: "restart_cap_exceeded"; runId: string; stepId: string; decision: RestartDecision };

/** Thrown when a step never stops failing transiently/overflow-wise within caps (AC4). */
export class CapExceededError extends Error {
  name = "CapExceededError";
  readonly reason = "cap-exceeded";
  readonly decision: RestartDecision;
  readonly lastSignal: FailureSignal;

  constructor(decision: RestartDecision, lastSignal: FailureSignal, thrown?: unknown) {
    super(
      `restart cap exceeded: ${decision.class} step halted with reason '${decision.reason}' after ${decision.class} failures`,
      // The last attempt's own error survives as `cause` — its stack/name/cause
      // (or the non-Error thrown value) stays reachable for the caller.
      thrown === undefined ? undefined : { cause: thrown },
    );
    this.decision = decision;
    this.lastSignal = lastSignal;
  }
}

export interface RunWithRestartOptions {
  runId: string;
  stepId: string;
  caps?: RestartCaps;
  /** Wall-clock reader, injectable for tests (default Date.now). */
  now?: () => number;
  /** Wait seam, injectable for tests (default a real setTimeout sleep). */
  sleep?: (ms: number) => Promise<void>;
  /** Structured audit events, in order. */
  onEvent?: (event: RestartEvent) => void;
}

/**
 * Drive one fallible step within the restart caps. The step throws either a
 * bare error (classified via its message shape — always logic unless it
 * carries a `failureSignal` property) or an error with a `failureSignal`
 * property. Overflow retries carry `attempt` forward so the step can reduce
 * its own scope; the caller reads `reducedScope` off the decision events.
 */
export async function runWithRestart<T>(
  step: (opts: { attempt: number; reducedScope: boolean }) => Promise<T> | T,
  opts: RunWithRestartOptions,
): Promise<T> {
  const caps = opts.caps ?? DEFAULT_RESTART_CAPS;
  const now = opts.now ?? Date.now;
  const sleep =
    opts.sleep ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      }));
  const startedAt = now();
  let retriesUsed = 0;
  // INV-RESTART-1: the wall clock is only ever read through `now()`; caps are
  // evaluated from the accumulated total before every retry.
  let attempt = 0;
  // `reducedScope` is the OVERFLOW decision's flag (the contract the decision
  // events speak) — a step retried after a plain transient backoff runs at
  // full scope, so the flag threads from the last decision, not from the
  // attempt ordinal.
  let lastDecision: RestartDecision | undefined;
  for (;;) {
    let lastSignal: FailureSignal | undefined;
    let thrown: unknown;
    try {
      const value = await step({ attempt, reducedScope: lastDecision?.reducedScope === true });
      opts.onEvent?.({ event: "restart_succeeded", runId: opts.runId, stepId: opts.stepId, attempt: attempt + 1 });
      return value;
    } catch (err) {
      thrown = err;
      const carried = (err as { failureSignal?: unknown })?.failureSignal;
      lastSignal =
        carried !== undefined && typeof carried === "object" && carried !== null && "type" in carried
          ? (carried as FailureSignal)
          : { type: "exception", message: err instanceof Error && err.message !== "" ? err.message : String(err) };
    }
    const cls = classifyFailure(lastSignal);
    opts.onEvent?.({ event: "restart_classification", runId: opts.runId, stepId: opts.stepId, attempt: attempt + 1, class: cls, signal: lastSignal });
    const wallClockMs = now() - startedAt;
    const decision = evaluateRestart(lastSignal, { class: cls, retriesUsed, wallClockMs, caps });
    lastDecision = decision;
    opts.onEvent?.({ event: "restart_decision", runId: opts.runId, stepId: opts.stepId, attempt: attempt + 1, decision });
    if (!decision.shouldRetry) {
      if (decision.reason === "cap-exceeded") {
        opts.onEvent?.({ event: "restart_cap_exceeded", runId: opts.runId, stepId: opts.stepId, decision });
        throw new CapExceededError(decision, lastSignal, thrown);
      }
      throw thrown instanceof Error ? thrown : new Error(String(thrown));
    }
    if (decision.nextBackoffMs !== undefined) await sleep(decision.nextBackoffMs);
    retriesUsed++;
    attempt++;
  }
}

// ─── the phase-record audit payload (written by phase.ts at settle) ─────────

/** What `PhaseRecord.restart` carries: the signal, the class, the decision. */
export type RestartAudit = {
  class: FailureClass;
  signal: FailureSignal;
  decision: RestartDecision;
};
