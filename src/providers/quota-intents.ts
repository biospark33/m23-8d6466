/**
 * Cross-process VM-headroom intents (Q1.5, G5).
 *
 * The VM-ceiling guard counted only what ONE process's driver listing could
 * see, so two CLI processes dispatching concurrently could both pass a ceiling
 * they each sampled before either box existed — dispatch.ts's own documented
 * open half. The fix is a durable INTENT record at the quota layer: each
 * dispatch claims one O_EXCL file BEFORE its headroom read, and a concurrent
 * `checkHeadroom` counts outstanding intents as live VMs until the box appears
 * (the claim is released once the driver listing can see the box) or the
 * intent ages out (a writer that crashed between claim and release).
 *
 * Files, not a table: the record's whole job is to be COUNTED and REMOVED —
 * no sums, no replay, no identity predicate — and it must be visible to two
 * processes that share nothing but the filesystem, which is the same surface
 * the run locks already arbitrate through. The claim is the SAME O_EXCL
 * posture `submitWork`'s intent claim uses.
 *
 * THE ONE DELIBERATE CEILING: the TTL (below) is a wall-clock guess about how
 * long a dispatch may run between its headroom read and its box appearing.
 * A dispatch that outruns it frees its headroom while it is still working —
 * the overshoot is bounded by the processes racing inside one TTL window, and
 * the DF2.6 reaper still sees and prices every box. The TTL is deliberately
 * generous against the dispatch wall-clock default (600 s) — the failure it
 * buys is an OVERSHOT START, not a lost reservation.
 */

import { existsSync, mkdirSync, chmodSync, readdirSync, readFileSync, unlinkSync, openSync, closeSync, writeSync, fsyncSync } from "node:fs";
import { join } from "node:path";
import { isValidUuidV4 } from "../phase-engine/issue-correlation.ts";

/** How long an unreleased intent counts as live, in ms. */
export const QUOTA_INTENT_TTL_MS = 15 * 60_000;

export interface QuotaIntentOpts {
  /** Injectable clock (test seam). */
  now?: () => number;
  /**
   * The caller's own claim, NOT counted — a dispatch must not refuse itself:
   * it counts the OTHER processes' intents (a concurrent dispatch's box may be
   * coming into existence), never its own.
   */
  exclude?: string;
}

/** The intents dir for a store, created 0700 on first use. */
function intentsDirFor(dir: string): string {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
  }
  return dir;
}

/**
 * Claim one headroom intent. Returns false when THIS requestId already holds
 * one — the O_EXCL is the arbiter, and a duplicate claim is the caller's own
 * bug (a dispatch does not run twice in one process).
 */
export function claimQuotaIntent(
  dir: string,
  requestId: string,
  opts: QuotaIntentOpts = {},
): boolean {
  return claimQuotaIntentWeighted(dir, requestId, 1, opts);
}

/**
 * Weighted claim (Q1.6): a fan-out's aggregate admission claims ONE intent
 * covering all N arms — the ceiling check that admitted it counted N, so the
 * intent that stands in for its not-yet-visible boxes counts N too. A plain
 * dispatch claims weight 1.
 */
export function claimQuotaIntentWeighted(
  dir: string,
  requestId: string,
  weight: number,
  opts: QuotaIntentOpts = {},
): boolean {
  if (!Number.isSafeInteger(weight) || weight < 1) {
    throw new Error(`claimQuotaIntentWeighted: weight must be a positive integer (got ${weight})`);
  }
  if (typeof requestId !== "string" || !isValidUuidV4(requestId)) {
    throw new Error(`claimQuotaIntent: requestId must be a strict UUID v4 (got ${JSON.stringify(requestId)})`);
  }
  const target = intentsDirFor(dir);
  const path = join(target, `${requestId}.json`);
  let fd: number;
  try {
    fd = openSync(path, "wx", 0o600);
  } catch {
    return false; // already claimed
  }
  try {
    writeSync(
      fd,
      `${JSON.stringify({
        requestId,
        weight,
        claimedAt: new Date((opts.now ?? Date.now)()).toISOString(),
      })}\n`,
    );
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return true;
}

/** Release this caller's claim. Releasing a claim you do not hold is a no-op. */
export function releaseQuotaIntent(dir: string, requestId: string): void {
  const path = join(dir, `${requestId}.json`);
  try {
    unlinkSync(path);
  } catch {
    /* never held, already released, or already swept — all fine */
  }
}

/**
 * Count the OUTSTANDING intents: files younger than the TTL. A stale one is
 * swept on read (best-effort — a concurrent sweep losing the race is fine),
 * a corrupt one is skipped (never counted, never fatal: an intent file this
 * process cannot parse must not fabricate headroom OR refuse it).
 */
export function countQuotaIntents(dir: string, opts: QuotaIntentOpts = {}): number {
  if (!existsSync(dir)) return 0;
  const now = (opts.now ?? Date.now)();
  let count = 0;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    if (opts.exclude !== undefined && entry === `${opts.exclude}.json`) continue;
    const path = join(dir, entry);
    let young = false;
    let weight = 1;
    try {
      const body = JSON.parse(readFileSync(path, "utf-8")) as { claimedAt?: string; weight?: number };
      const at = typeof body.claimedAt === "string" ? Date.parse(body.claimedAt) : Number.NaN;
      // Unparseable ⇒ young (fail-safe: over-count, never under-count).
      young = !Number.isFinite(at) || now - at < QUOTA_INTENT_TTL_MS;
      // A missing/non-weight field reads as 1 (every pre-weighting claim);
      // an INVALID weight fails safe UPWARD — over-count, never under-count.
      weight = Number.isSafeInteger(body.weight) && (body.weight as number) >= 1 ? (body.weight as number) : Number.MAX_SAFE_INTEGER;
    } catch {
      young = false; // corrupt ⇒ skipped, not counted
    }
    if (young) {
      count += weight;
    } else {
      try {
        unlinkSync(path);
      } catch {
        /* a concurrent sweep won the race — fine */
      }
    }
  }
  return count;
}

/** Test seam export: the intent file's stat, for wiring assertions. */
export function intentExists(dir: string, requestId: string): boolean {
  return existsSync(join(dir, `${requestId}.json`));
}
