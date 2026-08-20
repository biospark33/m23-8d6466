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

export class QuotaLimitsError extends Error {
  /** Machine-readable failure class; also the `code` in every log line. */
  readonly code: "quota-limits-unreadable" | "quota-limits-invalid";
  /** The literal next step, secrets referenced by env-var NAME, never expanded. */
  readonly remediation: string;

  constructor(
    code: "quota-limits-unreadable" | "quota-limits-invalid",
    message: string,
    remediation: string,
  ) {
    super(message);
    this.name = "QuotaLimitsError";
    this.code = code;
    this.remediation = remediation;
  }
}

/**
 * Load the ceilings. Absent file ⇒ defaults + source "default". Present ⇒
 * PARTIAL per-key override over defaults (unspecified keys keep their
 * defaults), source "file" + the path. Malformed JSON, unknown keys, or
 * non-positive/non-number values ⇒ QuotaLimitsError — a config that cannot be
 * trusted never falls back to defaults silently.
 */
export function loadQuotaLimits(file: string = DEFAULT_QUOTA_LIMITS_FILE): LoadedQuotaLimits {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ENOENT") return { limits: DEFAULT_QUOTA_LIMITS, source: "default" };
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
 * total is allowed. A driver.list() throw ⇒ `{ allowed: false, reason:
 * "list-unverified", headroom: 0, verified: false }` — never full headroom
 * from an uncounted population (AC4).
 */
export async function checkHeadroom(
  driver: HeadroomInput,
  requested: number,
  limits: LoadedQuotaLimits = loadQuotaLimits(),
): Promise<HeadroomResult> {
  const { limits: L } = limits;
  const base = {
    requested,
    ceiling: L.maxVms,
    diskEstimated: true as const,
    limitsSource: limits.source,
  };
  let vms: { name: string }[];
  try {
    vms = await driver.list();
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
  const liveVms = vms.length;
  const result = {
    ...base,
    liveVms,
    headroom: L.maxVms - liveVms,
    usedDiskGiB: liveVms * L.perVmDiskReservationGiB,
    verified: true as const,
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
