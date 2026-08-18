import {
  isSafePathComponent,
  sanitizePeerText,
} from "../../pi-vs-claude-code-vendor/coms-core.ts";
import type {
  ComsLogEntry,
  ExitStatus,
  MergedError,
  MergedOutput,
  Waiver,
  WorkerOutput,
} from "./types.ts";

/**
 * Cap on the total UTF-8 byte size of the merged `changedFiles` union —
 * parity with MAX_RESPONSE_SCHEMA_BYTES (P0.3-S-H6).
 */
export const MAX_CHANGED_FILES_BYTES = 32 * 1024;

/** Max UTF-16 length of a single changedFiles entry after sanitization. */
const MAX_CHANGED_FILE_LEN = 1024;

export type WorkerValidation =
  | { ok: true; output: WorkerOutput }
  | { ok: false; reason: string };

/**
 * changedFiles path policy (P0.3-S-H6, documented looser policy): entries are
 * RELATIVE paths whose every "/"-separated component passes coms-core's
 * `isSafePathComponent` (strict whitelist; rejects ".", "..", separators,
 * NULs, ADS colons). Absolute paths, traversal, and empty components are
 * rejected. This is looser than single-component-only (multi-level repo paths
 * are the common case) while keeping every component individually safe.
 */
function isSafeRelativePath(s: string): boolean {
  if (s.length === 0 || s.length > MAX_CHANGED_FILE_LEN) return false;
  return s.split("/").every((component) => isSafePathComponent(component));
}

/**
 * Validate a worker's raw structured reply (P0.3-S-H6 / CORRECTNESS-C).
 * `changedFiles: string[]` is MANDATORY — omission is a node failure. Each
 * entry is sanitized via coms-core `sanitizePeerText` (control chars stripped,
 * length-capped) and must be a safe relative path. `result` defaults to `{}`.
 */
export function validateWorkerOutput(
  agentId: string,
  raw: unknown,
): WorkerValidation {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: `worker ${agentId}: reply is not an object` };
  }
  const obj = raw as Record<string, unknown>;
  const files = obj.changedFiles;
  if (files === undefined) {
    return {
      ok: false,
      reason: `worker ${agentId}: mandatory changedFiles field missing`,
    };
  }
  if (!Array.isArray(files)) {
    return {
      ok: false,
      reason: `worker ${agentId}: changedFiles is not an array`,
    };
  }
  const sanitized: string[] = [];
  for (const entry of files) {
    if (typeof entry !== "string") {
      return {
        ok: false,
        reason: `worker ${agentId}: changedFiles entry is not a string`,
      };
    }
    const clean = sanitizePeerText(entry, "", MAX_CHANGED_FILE_LEN);
    if (!isSafeRelativePath(clean)) {
      return {
        ok: false,
        reason: `worker ${agentId}: unsafe changedFiles entry`,
      };
    }
    sanitized.push(clean);
  }
  const result = obj.result;
  const resultObj =
    typeof result === "object" && result !== null && !Array.isArray(result)
      ? (result as Record<string, unknown>)
      : {};
  return {
    ok: true,
    output: { agentId, changedFiles: sanitized, result: resultObj },
  };
}

/**
 * Set-union of per-worker changedFiles lists: dedupe, sort (deterministic
 * stdout), cap total UTF-8 size at MAX_CHANGED_FILES_BYTES — entries past the
 * cap are dropped (union is sorted first, so the drop is deterministic).
 */
export function unionChangedFiles(lists: string[][]): string[] {
  const set = new Set<string>();
  for (const list of lists) {
    for (const entry of list) set.add(entry);
  }
  const sorted = [...set].sort();
  const out: string[] = [];
  let bytes = 0;
  for (const entry of sorted) {
    const len = Buffer.byteLength(entry, "utf8");
    if (bytes + len > MAX_CHANGED_FILES_BYTES) break;
    bytes += len;
    out.push(entry);
  }
  return out;
}

export interface Pending<T> {
  readonly promise: Promise<T>;
  /** Settle once; returns false (no-op) if already settled (P0.3-S-H5). */
  settle: (value: T) => boolean;
  readonly settled: boolean;
}

/**
 * Atomic single-settle slot (P0.3-S-H5): a worker response and a `coms_await`
 * timeout may fire in the same tick — whichever calls `settle` first wins,
 * the loser's call returns false and emits nothing. Determinism comes from
 * this primitive, not from wall-clock proximity windows.
 */
export function createPending<T>(): Pending<T> {
  let settled = false;
  let resolveFn!: (v: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolveFn = resolve;
  });
  return {
    promise,
    get settled() {
      return settled;
    },
    settle(value: T): boolean {
      if (settled) return false;
      settled = true;
      resolveFn(value);
      return true;
    },
  };
}

/** Recursively redact every string value in a JSON-shaped structure (INV-3). */
export function redactDeep(value: unknown, redact: (s: string) => string): unknown {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, redact));
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = redactDeep(v, redact);
    }
    return out;
  }
  return value;
}

export interface BuildMergedOutputOptions {
  exitStatus: ExitStatus;
  partial: boolean;
  result: Record<string, unknown>;
  agentOutputs: Record<string, unknown>;
  changedFiles: string[];
  comsLog: ComsLogEntry[];
  durationMs: number;
  waivers: Waiver[];
  error: MergedError | null;
  /** Secret redaction fn (runner's redactSecrets bound to the parent env). */
  redact: (s: string) => string;
  /** DF1.6: Test results from engine-side test runner. */
  testResults: { passed: number; failed: number };
  /** DF1.6: Must be present; false when passed+failed===0 (p1-6:62). */
  testsExecuted: boolean;
  /** DF1.6: Top-level summary (copied from result.summary with 2000-char cap). */
  summary: string;
  /** DF1.6: Mulch priming success flag. */
  mulchPrimed: boolean;
  /** DF1.6: Mulch priming error, null when priming succeeded or not attempted. */
  mulchPrimeError: string | null;
  /** DF1.6: Artifacts produced by the team. */
  artifacts: Array<{ name: string; path: string }>;
  /** DF1.6: Partial output for failure paths (≤10000 chars with suffix), null on success. */
  partialOutput: string | null;
}

/** Max UTF-16 length of top-level summary field (p1-6:65). */
const MAX_SUMMARY_CHARS = 2000;

/**
 * Max UTF-16 length of partialOutput field (p1-6:65).
 * Exported for single-source-of-truth with runner (R4).
 */
export const MAX_PARTIAL_OUTPUT_CHARS = 10000;

/**
 * Suffix appended by truncateWithSuffix when truncation occurs.
 * Exported so runner can leave headroom for it (R4).
 */
export const TRUNCATION_SUFFIX = "[truncated, N chars total]";

/**
 * Length of the longest possible truncation suffix ([truncated, 999999999 chars total]).
 * Used by runner to reserve headroom so the marker always appears when truncation happened.
 * Exported for single-source-of-truth (R4).
 */
export const MAX_SUFFIX_LENGTH = TRUNCATION_SUFFIX.replace("N", "999999999").length;

/**
 * Truncate a string to a max length, reserving space for suffix before cutting.
 * Suffix format: "[truncated, N chars total]" where N is the original length.
 */
function truncateWithSuffix(
  text: string,
  maxLength: number,
  suffixLabel = "chars",
): string {
  if (text.length <= maxLength) return text;
  const suffix = `[truncated, ${text.length} ${suffixLabel} total]`;
  const proseBudget = maxLength - suffix.length;
  if (proseBudget < 0) {
    // R8: When maxLength is smaller than the suffix, return a marker-bearing fallback.
    // Keep at least "[…]" visible; trim the suffix itself if needed.
    const minimalMarker = "[…]";
    if (maxLength >= 3) return minimalMarker;
    // Even smaller: return minimal marker trimmed to maxLength (may be just "[").
    return minimalMarker.slice(0, maxLength);
  }
  // Walk back from proseBudget to avoid splitting a UTF-16 surrogate pair
  // (mirrors runner.ts partial-output handling, R7).
  let cutPoint = proseBudget;
  while (
    cutPoint > 0 &&
    text.charCodeAt(cutPoint - 1) >= 0xD800 &&
    text.charCodeAt(cutPoint - 1) <= 0xDBFF
  ) {
    cutPoint--;
  }
  return text.slice(0, cutPoint) + suffix;
}

/**
 * Build the merged team output with P0.3-M2 uniformity enforced at the
 * construction site, not by caller discipline:
 *   - success  → error MUST be null (explicit), partial false by contract;
 *   - non-success → error{reason,message} MUST be present;
 *   - lead_failure → agentOutputs forced to {} (never absent);
 *   - every path emits the identical field set;
 *   - redaction applied deep to result/agentOutputs/comsLog/error (INV-3).
 * DF1.6 extensions:
 *   - summary copied from result.summary with 2000-char ceiling including suffix;
 *   - testsExecuted invariant: must be present and false when passed+failed===0;
 *   - partialOutput truncated to 10000 chars with suffix;
 *   - result stays byte-identical.
 */
export function buildMergedOutput(
  opts: BuildMergedOutputOptions,
): MergedOutput {
  const { exitStatus, testResults, testsExecuted } = opts;

  // Existing invariants
  if (exitStatus === "success") {
    if (opts.error !== null) {
      throw new Error("merged output: success path must carry error:null");
    }
    if (opts.partial) {
      throw new Error("merged output: success path must carry partial:false");
    }
  } else if (opts.error === null) {
    throw new Error(
      `merged output: ${exitStatus} path requires error{reason,message}`,
    );
  }

  // DF1.6 testsExecuted invariant (p1-6:62, R9)
  // R9: Reject negative/non-integer counts; reject testsExecuted === false when passed+failed > 0.
  // Keep existing sum===0 rule.
  const { passed, failed } = testResults;
  if (!Number.isInteger(passed) || passed < 0) {
    throw new Error(
      `merged output: passed must be a non-negative integer, got ${passed}`,
    );
  }
  if (!Number.isInteger(failed) || failed < 0) {
    throw new Error(
      `merged output: failed must be a non-negative integer, got ${failed}`,
    );
  }
  const sum = passed + failed;
  if (sum === 0) {
    if (testsExecuted !== false) {
      throw new Error(
        `merged output: testsExecuted must be false when passed+failed===0, got ${testsExecuted}`,
      );
    }
  } else if (testsExecuted === false) {
    // R9: When tests ran (sum > 0), testsExecuted must be true.
    throw new Error(
      `merged output: testsExecuted must be true when passed+failed > 0 (got ${sum}), got false`,
    );
  }

  const agentOutputs =
    exitStatus === "lead_failure" ? {} : opts.agentOutputs;
  // lead_failure carries changedFiles:[] by contract (path 5) — forced here,
  // not by caller discipline.
  const changedFiles =
    exitStatus === "lead_failure" ? [] : opts.changedFiles;
  const redact = opts.redact;

  // DF1.6: Copy summary from result.summary with truncation. Redact BEFORE
  // truncating (INV-4): the top-level summary is an outbound string — a
  // secret echoed in result.summary must not survive the copy-up.
  const rawSummary = redact(
    typeof opts.result.summary === "string" ? opts.result.summary : opts.summary,
  );
  const summary = truncateWithSuffix(rawSummary, MAX_SUMMARY_CHARS);

  // DF1.6: Truncate partialOutput when the field is a string, otherwise null —
  // redacted for the same reason (every string leaving the phase passes redact
  // once). Null/undefined-checked, not truthiness: an EMPTY failure output
  // must survive as "" — collapsing it to null would erase the distinction
  // between "failure with no partial output" and "field omitted" (undefined
  // is tolerated because older call sites omit it). Success is FORCED to
  // null, mirroring changedFiles/agentOutputs on lead_failure: the contract
  // "null on success" is enforced at this construction site, not by caller
  // discipline.
  const partialOutput =
    exitStatus === "success"
      ? null
      : opts.partialOutput !== undefined && opts.partialOutput !== null
        ? truncateWithSuffix(redact(opts.partialOutput), MAX_PARTIAL_OUTPUT_CHARS, "chars")
        : null;

  return {
    result: redactDeep(opts.result, redact) as Record<string, unknown>,
    changedFiles: changedFiles.map((f) => redact(f)),
    partial: opts.partial,
    exitStatus,
    durationMs: opts.durationMs,
    // INV-3 breadth: waivers carry operator/peer-authored strings (reason,
    // approvedBy) — redact them so no secret can ride the audit trail.
    waivers: redactDeep(opts.waivers, redact) as Waiver[],
    agentOutputs: redactDeep(agentOutputs, redact) as Record<string, unknown>,
    comsLog: redactDeep(opts.comsLog, redact) as ComsLogEntry[],
    error:
      opts.error === null
        ? null
        : (redactDeep(opts.error, redact) as MergedError),
    // DF1.6: Extended fields
    testResults: { passed: testResults.passed, failed: testResults.failed },
    testsExecuted,
    summary,
    mulchPrimed: opts.mulchPrimed,
    mulchPrimeError: opts.mulchPrimeError ?? null,
    artifacts: opts.artifacts.map((a) => ({
      name: redact(a.name),
      path: redact(a.path),
    })),
    partialOutput,
  };
}
