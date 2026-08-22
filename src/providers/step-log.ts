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
import { SECRET_PREFIXES } from "./run-record.ts";

/**
 * INV-2 in the other direction: `assertNoSecret` REFUSES these shapes on the
 * way into a record; this masks them on the way into a log line.
 *
 * Load-bearing on the credentials path. `deliverRunKey` writes the minted
 * OpenRouter key into the box through `driver.exec`, and an exec wrapper that
 * echoes the failed argv — the ordinary way one reports a failure — puts the
 * key plaintext into `err.message`, which this module then writes out. INV-4
 * says the plaintext exists in the mint return and nowhere else. Dispatch's
 * `redactUrls` is no help here and could not be reused anyway: it only matches
 * `https?://…`, a bare `sk-…` has no scheme, and `src/providers/` does not
 * import from `src/fleet/`.
 *
 * Two arms, both lifted from `assertNoSecret`'s reasoning:
 *  - the known prefixes, matched at a token boundary so `task-runner` does not
 *    trip on `sk-`;
 *  - a long mixed-class token, for an issuer whose prefix is not on the list.
 *    The mixed-class requirement is what keeps a 40-char all-hex git SHA and an
 *    all-lowercase run id — the fields these lines exist to carry — readable.
 */
const SECRET_PREFIX_RE = new RegExp(
  `(^|[^A-Za-z0-9])(?:${SECRET_PREFIXES.map((p) => p.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&")).join("|")})[A-Za-z0-9+/=_.:-]*`,
  "g",
);
const LONG_TOKEN_RE = /[A-Za-z0-9+/=_.:-]{40,}/g;

export function redactSecrets(text: string): string {
  return text
    .replace(SECRET_PREFIX_RE, (_m, lead: string) => `${lead}«redacted»`)
    .replace(LONG_TOKEN_RE, (t) =>
      /[a-z]/.test(t) && /[A-Z]/.test(t) && /\d/.test(t) ? "«redacted»" : t,
    );
}

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
 * never swallows or reshapes a failure. The message and remediation are
 * secret-redacted on the way OUT (see `redactSecrets`); the re-thrown error is
 * untouched, so a caller that needs the raw text still has it.
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
      // Redacted, not dropped: the free text is how an operator diagnoses a
      // failed step, and every step here can carry provider text. The code is
      // ours and never carries a value.
      error: { code: err.code ?? labels.errorCode, message: redactSecrets(err.message ?? String(e)) },
      // `typeof`, not `??`: `fn` may reject with a non-Error carrying a null
      // remediation, and that must not reach the redactor.
      remediation: typeof err.remediation === "string" ? redactSecrets(err.remediation) : null,
      outcome: labels.error,
      [`${step}_ms`]: durationMs,
    });
    throw e;
  }
}
