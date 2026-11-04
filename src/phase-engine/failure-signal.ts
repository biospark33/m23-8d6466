/**
 * P1.9 — the failure signal contract and the deterministic classifier.
 *
 * A `FailureSignal` is the DATA a failed step hands back — what happened, not
 * what to do. The classifier maps signal → `FailureClass`, the three-value
 * failure subset of the CC-1 five-value `exitStatus` enum
 * (`cli-anything/src/types.ts`): `success` and `lead_failure` are outside this
 * story's taxonomy (lead failures have the DF6.1b escalation lane).
 *
 * INV-RESTART-2: `classifyFailure` is pure — no randomness, no clock, no
 * external state. The same signal always produces the same class, which is
 * what makes a cross-run restart decision auditable after the fact.
 *
 * Rule precedence (first match wins, evaluated in this order):
 *  1. **Token arithmetic beats the label** — a signal whose `tokensUsed`
 *     exceeds `maxTokens` is overflow whatever its `type` says.
 *  2. `type: "timeout"` → transient (the spec's own example: a step timeout
 *     is a transient failure).
 *  3. `type: "token-overflow"` → overflow.
 *  4. `type: "http-status"` → transient iff `code` is 408/429/5xx.
 *  5. **Fail closed** — everything else is `logic`. An unclassifiable failure
 *     never earns a retry (same doctrine as the engine's exitStatus fallback).
 */
import { z } from "zod";

export const FailureSignalSchema = z
  .strictObject({
    /** Closed-vocabulary label; unknown labels classify logic (fail-closed). */
    type: z.string().min(1),
    message: z.string().min(1),
    code: z.number().int().optional(),
    tokensUsed: z.number().int().nonnegative().optional(),
    maxTokens: z.number().int().positive().optional(),
    duration: z.number().nonnegative().optional(),
  })
  .strict();

export type FailureSignal = z.infer<typeof FailureSignalSchema>;

/** The failure subset of CC-1's exitStatus enum (the DF5.5 amendment's three values). */
export type FailureClass = "transient" | "overflow" | "logic";

export const FAILURE_CLASSES: readonly FailureClass[] = ["transient", "overflow", "logic"];

/** Upstream statuses that self-heal: request timeout, rate limit, server errors. */
export const TRANSIENT_HTTP_CODES: ReadonlySet<number> = new Set([408, 429, 500, 502, 503, 504]);

export function isFailureClass(v: unknown): v is FailureClass {
  return typeof v === "string" && (FAILURE_CLASSES as readonly string[]).includes(v);
}

export function classifyFailure(signal: FailureSignal): FailureClass {
  if (
    signal.tokensUsed !== undefined &&
    signal.maxTokens !== undefined &&
    signal.tokensUsed > signal.maxTokens
  ) {
    return "overflow";
  }
  if (signal.type === "timeout") return "transient";
  if (signal.type === "token-overflow") return "overflow";
  if (signal.type === "http-status") {
    return signal.code !== undefined && TRANSIENT_HTTP_CODES.has(signal.code) ? "transient" : "logic";
  }
  return "logic";
}
