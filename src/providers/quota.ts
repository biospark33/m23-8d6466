/**
 * Quota accounting (DF2.6) — the two account ceilings every createRun refuses
 * against, plus the operator-tunable limits file.
 *
 * checkHeadroom is a READ, not a lock (story Technical Notes): it counts the
 * live population at decision time and reserves nothing — two concurrent
 * creates can both pass and both land. The ceiling is a backstop against
 * fleet drift, not an admission controller.
 *
 * Fail-closed shape mirrors the rest of the seam: an unenumerable VM list is
 * `{ allowed: false, reason: "list-unverified" }` — never full headroom
 * computed from a population that was never counted. A limits file that
 * cannot be parsed is a refusal (QuotaLimitsError) whose remediation carries
 * the exact JSON body to write — the exedev posture pattern
 * (exedev/driver.ts:269-285).
 *
 * D4: this module imports NOTHING from driver.ts — checkHeadroom takes the
 * structural `HeadroomInput`, so driver.ts can import quota.ts (createRun's
 * headroom gate) without a cycle.
 */

import { readFileSync } from "node:fs";

import { log, newRequestId } from "../swarmclaw/log.ts";
import { LIST_TIMEOUT_MS, withTimeout } from "./timeout.ts";
import { ProviderError } from "./errors.ts";
import { countQuotaIntents } from "./quota-intents.ts";

export interface QuotaLimits {
  /** Concurrent provider VMs (D5: foreign VMs burn the same ceiling). */
  maxVms: number;
  /** Pooled account disk, estimated as liveVms × perVmDiskReservationGiB. */
  maxPooledDiskGiB: number;
  perVmDiskReservationGiB: number;
  /** Recorded in the sweep header only — no transfer enforcement lives here. */
  maxTransferGiB: number;
  /** A record/key older than this is stale, not in flight (DF2.6 reaper). */
  staleAfterMs: number;
}

/**
 * Defaults are vendor-single-origin [VERIFY] (R5 §6 fact 11): 50 VMs / 100 GiB
 * pooled / 2 GiB per-VM reservation (D7) / 200 GiB transfer / 4h staleness.
 */
export const DEFAULT_QUOTA_LIMITS: QuotaLimits = {
  maxVms: 50,
  maxPooledDiskGiB: 100,
  perVmDiskReservationGiB: 2,
  maxTransferGiB: 200,
  staleAfterMs: 14_400_000,
};

export type QuotaLimitsSource = "default" | "file";

export interface LoadedQuotaLimits {
  limits: QuotaLimits;
  source: QuotaLimitsSource;
  /** Set when source is "file" — the path the ceilings were read from. */
  file?: string;
}

/**
 * Cwd-relative default — the `.sandbox/` tree is per-project by design (records
 * `.sandbox/runs`, reap reports `.sandbox/reap`). Resolution order mirrors
 * run-record.ts's `$QDS_RUNS_DIR` tier: explicit argument → `$QDS_QUOTA_LIMITS_FILE`
 * → this cwd-relative default.
 */
export const DEFAULT_QUOTA_LIMITS_FILE = ".sandbox/quota-limits.json";

const LIMIT_KEYS: readonly (keyof QuotaLimits)[] = [
  "maxVms",
  "maxPooledDiskGiB",
  "perVmDiskReservationGiB",
  "maxTransferGiB",
  "staleAfterMs",
];

/** The remediation body: a complete, copy-pasteable limits file (exedev posture pattern). */
const EXAMPLE_BODY =
  '{"maxVms": 50, "maxPooledDiskGiB": 100, "perVmDiskReservationGiB": 2, "maxTransferGiB": 200, "staleAfterMs": 14400000}';

export class QuotaLimitsError extends ProviderError {
  /** Machine-readable failure class; also the `code` in every log line. `declare` narrows the base's field — see SweepError. */
  declare readonly code: "quota-limits-unreadable" | "quota-limits-invalid";

  constructor(
    code: "quota-limits-unreadable" | "quota-limits-invalid",
    message: string,
    remediation: string,
  ) {
    super(code, message, remediation);
    this.name = "QuotaLimitsError";
  }
}

/**
 * Load the ceilings. Absent file ⇒ defaults + source "default". Present ⇒
 * PARTIAL per-key override over defaults (unspecified keys keep their
 * defaults), source "file" + the path. Malformed JSON, unknown keys, or
 * non-positive/non-number values ⇒ QuotaLimitsError — a config that cannot be
 * trusted never falls back to defaults silently.
 */
export function loadQuotaLimits(
  file: string = process.env.QDS_QUOTA_LIMITS_FILE ?? DEFAULT_QUOTA_LIMITS_FILE,
): LoadedQuotaLimits {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      // Absent is a legitimate layout, but it is NOT the same as "the ceilings
      // you configured". $QDS_QUOTA_LIMITS_FILE can silently swap an
      // operator's caps for the built-ins, and these ceilings gate createRun's
      // headroom check — the same fleet admitted against a different ceiling,
      // with nothing saying so. Name the path we looked at; the fallback
      // itself stays non-fatal. Guarded like cost-ledger's twin line: a
      // raising sink must not turn a legitimate layout into a thrown error.
      try {
        log({
          requestId: newRequestId(),
          operation: "quota.limits",
          agentId: null,
          timestamp: new Date().toISOString(),
          duration: 0,
          status: "ok",
          code: "quota-limits-absent-using-defaults",
          limitsFile: file,
          maxVms: DEFAULT_QUOTA_LIMITS.maxVms,
          message: `no quota limits at ${file} — ceilings fall back to the built-in defaults`,
          outcome: "default-limits",
        });
      } catch (e2) {
        // Named once on stderr like cost-ledger's `emitGuarded`: a swallowed
        // throw here means the absent-config signal is gone AND nothing says
        // it is gone. The fallback itself stands either way.
        try {
          process.stderr.write(
            `quota: log sink threw for quota.limits (${(e2 as Error).message}) — defaults stand\n`,
          );
        } catch {
          // best-effort diagnostic only
        }
      }
      return { limits: DEFAULT_QUOTA_LIMITS, source: "default" };
    }
    throw new QuotaLimitsError(
      "quota-limits-unreadable",
      `cannot read the quota limits file ${file} (${err.message ?? String(e)}) — refusing to guess ceilings`,
      `fix the permissions on ${file}, or replace its body with e.g. ${EXAMPLE_BODY}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new QuotaLimitsError(
      "quota-limits-unreadable",
      `quota limits file ${file} is not valid JSON: ${(e as Error).message} — refusing to guess ceilings`,
      `write a valid JSON object over it, e.g. ${EXAMPLE_BODY}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw invalidFile(file, "the body is not a JSON object");
  }
  const over: Partial<QuotaLimits> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!(LIMIT_KEYS as readonly string[]).includes(key)) {
      throw invalidFile(file, `unknown key ${JSON.stringify(key)}`);
    }
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      throw invalidFile(file, `${key} must be a positive number (got ${JSON.stringify(value)})`);
    }
    over[key as keyof QuotaLimits] = value;
  }
  return { limits: { ...DEFAULT_QUOTA_LIMITS, ...over }, source: "file", file };
}

function invalidFile(file: string, detail: string): QuotaLimitsError {
  return new QuotaLimitsError(
    "quota-limits-invalid",
    `quota limits file ${file}: ${detail}`,
    `write a partial-or-full override object whose keys are a subset of the known limits, e.g. ${EXAMPLE_BODY}`,
  );
}

// ─── headroom ────────────────────────────────────────────────────────────────

/**
 * Structural driver view — deliberately NOT ProviderDriver (D4): quota.ts must
 * not import driver.ts, or createRun's headroom gate becomes an import cycle.
 */
export interface HeadroomInput {
  list(name?: string): Promise<{ name: string }[]>;
  /**
   * The listing plus what it refused to name, structurally typed (D4 — the
   * value shape mirrors `ProviderVmListing` without importing it). OPTIONAL,
   * additive like the seam's own: when present, the population count comes
   * from HERE, because a row the driver dropped is a possible live box —
   * counting only what `list()` reports undercounts the population and admits
   * creates against spend nobody enumerated (fail-open). Any non-empty
   * `skipped` refuses outright (`list-unverified`, transient — never
   * full-headroom-from-an-undercount).
   */
  listWithAnomalies?(name?: string): Promise<{
    vms: { name: string }[];
    skipped: readonly string[];
  }>;
}

export interface HeadroomResult {
  allowed: boolean;
  /** 0 + verified:false when the list could not be enumerated. */
  liveVms: number;
  /** maxVms. */
  ceiling: number;
  /** ceiling - liveVms; 0 when unverified. */
  headroom: number;
  requested: number;
  /** liveVms × perVmDiskReservationGiB — an estimate, never a measurement. */
  usedDiskGiB: number;
  /** Constant — the disk figure is never shown as measured. */
  diskEstimated: true;
  /** False iff the VM list could not be enumerated. */
  verified: boolean;
  limitsSource: QuotaLimitsSource;
  reason?: "list-unverified" | "vm-ceiling" | "pooled-disk";
}

/**
 * Count the live population and refuse on EITHER ceiling. Boundary inclusive:
 * `liveVms + n === maxVms` is allowed, and landing exactly on the pooled-disk
 * total is allowed. A driver.list() throw — or a list() that never settles,
 * bounded here by the same withTimeout/LIST_TIMEOUT_MS the reaper's sweep
 * uses — ⇒ `{ allowed: false, reason: "list-unverified", headroom: 0,
 * verified: false }` — never full headroom from an uncounted population
 * (AC4). `listTimeoutMs` exists so tests can exercise that refusal without
 * parking on the real 15s budget.
 */
export async function checkHeadroom(
  driver: HeadroomInput,
  requested: number,
  limits: LoadedQuotaLimits = loadQuotaLimits(),
  listTimeoutMs: number = LIST_TIMEOUT_MS,
  /**
   * Q1.5: outstanding cross-process VM intents, counted as LIVE VMs beside the
   * driver listing. Absent (the default) ⇒ the check is single-process — the
   * exact behaviour every pre-Q1.5 caller keeps. Dispatch passes its
   * intents dir; the closed ceiling is the point (G5).
   */
  intents?: { dir: string; now?: () => number; exclude?: string },
): Promise<HeadroomResult> {
  // Guard against caller bugs: negative or zero requested makes headroom nonsense
  if (!Number.isFinite(requested) || !Number.isInteger(requested) || requested < 1) {
    throw new Error(`checkHeadroom: requested must be a positive integer (got ${requested})`);
  }
  const { limits: L } = limits;
  const base = {
    requested,
    ceiling: L.maxVms,
    diskEstimated: true as const,
    limitsSource: limits.source,
  };
  let vms: { name: string }[];
  try {
    // The anomaly channel when the driver has one, `list()` otherwise (same
    // fallback contract as the seam's `driverListing` — a driver without the
    // channel has claimed nothing about completeness either way). A non-empty
    // `skipped` is rows this driver COULD NOT name — possible live boxes — so
    // it refuses exactly like an enumeration failure: `list-unverified` is
    // transient at every consumer (dispatch and fanout both classify it
    // retryable), which is precisely the right posture for "the count is not
    // proven": refuse once, admit on the next clean answer.
    if (driver.listWithAnomalies !== undefined) {
      const listing = await withTimeout(driver.listWithAnomalies(), listTimeoutMs, "driver.list()");
      // `skipped` is part of the same verified-listing contract as `vms`: a
      // listing whose skipped channel is missing or not an array has claimed
      // nothing about completeness either way, and dereferencing it used to
      // rely on the surrounding catch to land in the same refusal — refuse it
      // in the guard itself, matching the vms check beside it.
      const listed = Array.isArray(listing?.vms) ? listing.vms : undefined;
      const skipped = listing?.skipped;
      if (listed === undefined || !Array.isArray(skipped) || skipped.length > 0) {
        return { ...base, allowed: false, liveVms: 0, headroom: 0, usedDiskGiB: 0, verified: false, reason: "list-unverified" };
      }
      vms = listed;
    } else {
      vms = await withTimeout(driver.list(), listTimeoutMs, "driver.list()");
    }
  } catch {
    return {
      ...base,
      allowed: false,
      liveVms: 0,
      headroom: 0,
      usedDiskGiB: 0,
      verified: false,
      reason: "list-unverified",
    };
  }
  // AC4: fail-closed — a contract-violating non-array list is unenumerable (list-unverified), never a crash
  if (!Array.isArray(vms)) {
    return {
      ...base,
      allowed: false,
      liveVms: 0,
      headroom: 0,
      usedDiskGiB: 0,
      verified: false,
      reason: "list-unverified",
    };
  }
  // Q1.5: intents this process cannot see in the listing count as live. The
  // merge happens AFTER the verified-listing gates — a corrupt or partial
  // listing still refuses on its own terms before intents are consulted.
  const intentCount =
    intents === undefined ? 0 : countQuotaIntents(intents.dir, { now: intents.now, exclude: intents.exclude });
  const liveVms = vms.length + intentCount;
  const result = {
    ...base,
    liveVms,
    headroom: L.maxVms - liveVms,
    usedDiskGiB: liveVms * L.perVmDiskReservationGiB,
    verified: true as const,
    ...(intentCount > 0 ? { outstandingIntents: intentCount } : {}),
  };
  if (liveVms + requested > L.maxVms) {
    return { ...result, allowed: false, reason: "vm-ceiling" as const };
  }
  if ((liveVms + requested) * L.perVmDiskReservationGiB > L.maxPooledDiskGiB) {
    return { ...result, allowed: false, reason: "pooled-disk" as const };
  }
  return { ...result, allowed: true };
}

/** Thrown by createRun when checkHeadroom(1) refuses — carries the full result. */
export class HeadroomRefusedError extends Error {
  readonly code = "headroom-refused";
  readonly result: HeadroomResult;

  constructor(result: HeadroomResult) {
    super(
      `refusing to create ${result.requested} VM(s): ${result.reason} — live ${result.liveVms}/${result.ceiling} (headroom ${result.headroom}, disk ~${result.usedDiskGiB} GiB)`,
    );
    this.name = "HeadroomRefusedError";
    this.result = result;
  }
}
