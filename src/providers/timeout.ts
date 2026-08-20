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
 * Bound one provider call. The losing promise's late rejection is attached a
 * no-op catch BEFORE the race so it can never surface as an unhandled
 * rejection after the timeout has already refused the caller.
 */
export async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  void p.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
