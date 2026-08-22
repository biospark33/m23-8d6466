/**
 * Shared async bounds (DF2.6) — the generic call-timeout helper both quota.ts
 * (checkHeadroom's enumeration) and reaper.ts (the sweep's per-unit provider
 * ops) use. A leaf module by design: it imports nothing from the seam, so D4's
 * one-way dependency rule (driver.ts → quota.ts, reaper.ts → quota.ts) gains a
 * second safe leaf instead of a cycle, and quota.ts stays quota-only.
 */

/** Shared per-call enumeration budget — checkHeadroom and the reaper sweep. */
export const LIST_TIMEOUT_MS = 15_000;

/**
 * A call that exceeded its budget — a distinct CLASS, not a message shape.
 * `provisionAdmittedRun` has to tell "the provider never answered" (which it
 * reclassifies into a `ProvisionRefusedError` carrying a code and a
 * remediation) from the driver's OWN typed refusal (which already carries
 * both and must reach the caller unreshaped), and classifying on message text
 * is exactly what a `code` field exists to avoid.
 *
 * Deliberately carries NO `code` property: reaper.ts's apply loop reads
 * `err.code ?? "<unit>-failed"`, so adding one here would silently rename
 * every wedged-unit failure code in the sweep report. The message is
 * byte-identical to the bare `Error` this replaced.
 */
export class TimeoutError extends Error {
  /** The call description passed to `withTimeout`. */
  readonly what: string;
  /** The budget that expired, in milliseconds. */
  readonly ms: number;

  constructor(what: string, ms: number) {
    super(`${what} timed out after ${ms}ms`);
    this.name = "TimeoutError";
    this.what = what;
    this.ms = ms;
  }
}

/**
 * Bound one provider call. The losing promise's late rejection is attached a
 * no-op catch BEFORE the race so it can never surface as an unhandled
 * rejection after the timeout has already refused the caller. This relies on
 * standard promise-reaction scheduling: the catch reaction is registered at
 * attach time, not on microtask ordering between the race and the rejection.
 */
export async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  void p.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(what, ms)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
