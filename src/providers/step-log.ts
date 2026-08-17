/**
 * Shared per-step observability (DF2.5) — the one timed/logged-step shape
 * behind harvest's `timedStep` and teardown's `runStep`.
 *
 * Both streams emit the credentials.ts `timed` contract: one JSON line per
 * step with `duration` + `durationMs` + a `<step>_ms` sub-timing, `status`,
 * and an outcome drawn from each stream's own vocabulary (harvest ok/error,
 * teardown ran/failed/skipped). The vocabulary and the operation prefix are
 * the only per-caller differences, so they are the only parameters.
 */

import { log } from "../swarmclaw/log.ts";

/** Per-step log context — propagated ids plus the driver name. */
export interface StepCtx {
  requestId: string;
  runId: string;
  driver: string;
}

/** Base fields of every step line; `operation` is `<prefix>.<step>`. */
export function stepBase(ctx: StepCtx, prefix: string, step: string) {
  return {
    requestId: ctx.requestId,
    operation: `${prefix}.${step}`,
    agentId: null,
    timestamp: new Date().toISOString(),
    runId: ctx.runId,
    step,
    driver: ctx.driver,
  };
}

export interface StepLogLabels {
  /** Ok-path outcome (harvest: "ok"; teardown: "ran"). */
  ok: string;
  /** Error-path outcome (harvest: "error"; teardown: "failed"). */
  error: string;
  /** Fallback code when the thrown value carries none of its own. */
  errorCode: string;
}

/**
 * Run `fn` as one timed, logged step. A throw is logged (code + remediation,
 * env-var NAMES only, never expanded) and re-thrown unchanged — the logger
 * never swallows or reshapes a failure.
 */
export async function timedLoggedStep<T>(
  ctx: StepCtx,
  prefix: string,
  step: string,
  labels: StepLogLabels,
  fn: () => Promise<T>,
): Promise<T> {
  const started = Date.now();
  const base = stepBase(ctx, prefix, step);
  try {
    const result = await fn();
    const durationMs = Date.now() - started;
    log({ ...base, duration: durationMs, durationMs, status: "ok", outcome: labels.ok, [`${step}_ms`]: durationMs });
    return result;
  } catch (e) {
    const durationMs = Date.now() - started;
    // `fn` may reject with a non-Error — even null/undefined. Normalize so the
    // logger cannot itself throw (and mask the original failure) while
    // reporting one.
    const err = (e ?? {}) as { code?: string; message?: string; remediation?: string };
    log({
      ...base,
      duration: durationMs,
      durationMs,
      status: "error",
      error: { code: err.code ?? labels.errorCode, message: err.message ?? String(e) },
      remediation: err.remediation ?? null, // env-var names only, never expanded
      outcome: labels.error,
      [`${step}_ms`]: durationMs,
    });
    throw e;
  }
}
