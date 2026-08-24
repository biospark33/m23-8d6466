/**
 * The `ReverifyReport` contract (Story DF5.1).
 *
 * The verdict is a PURE FUNCTION of the evidence, computed here and nowhere
 * else. There is no setter, no constructor parameter and no deserialization
 * path that accepts a verdict — the same discipline DF1.2's `GateReport`
 * applies to `passed`, one layer up (INV-RV-5). A caller assembles evidence;
 * only this module decides what that evidence means.
 *
 * Reports persist append-only at `.sandbox/reverify/<run-id>.jsonl`, one
 * record per line, the last line authoritative for DF5.2. A red is never
 * retried into a green: a re-run appends a NEW report with its own
 * `reverifyId` and both are retained (§8 step 0's discipline).
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { redactSecrets } from "../../cli-anything/src/redact.ts";
import type { GateCheck } from "../phase-engine/gates/report.ts";
import { EXIT_STATUSES } from "../../cli-anything/src/types.ts";

/** Per-check evidence cap, suffix INCLUDED (story: Guards/limits). */
export const NOTE_MAX_CHARS = 1_000;
/** Hard cap on examined items carried in one report. */
export const CHECKS_MAX = 500;

export type ReverifyVerdict = "green" | "red" | "error";

/**
 * The purpose-built redaction map (INV-RV-4): the run's OWN known-sensitive
 * values — the minted provider key and its hash, the host GitHub token, the
 * approver token — assembled by the caller. Never `process.env`: INV-RV-3
 * already stripped those values from the verify process, so redacting against
 * the environment would redact nothing at all.
 *
 * Keys must look secret-ish to `redactSecrets`' `SECRET_KEY_RE` and values must
 * clear `MIN_REDACTABLE_VALUE_LEN`; `assertRedactable` enforces the first at
 * the boundary so a mis-keyed map fails loudly instead of silently passing the
 * secret through.
 */
export type RedactionMap = Record<string, string>;

const TimingsSchema = z
  .object({
    worktree_ms: z.number().int().min(0),
    install_ms: z.number().int().min(0),
    tests_ms: z.number().int().min(0),
    gates_ms: z.number().int().min(0),
    cleanup_ms: z.number().int().min(0),
  })
  .strict();

const GateCheckSchema = z
  .object({ item: z.string(), ok: z.boolean(), note: z.string() })
  .strict();

const TestResultsSchema = z
  .object({ passed: z.number().int().min(0), failed: z.number().int().min(0) })
  .strict();

/**
 * What the box CLAIMED, parsed against DF1.6's merged step output shape. It
 * feeds `discrepancies` and nothing else — never the verdict (INV-RV-1).
 */
const ClaimedSchema = z
  .object({
    exitStatus: z.enum(EXIT_STATUSES as unknown as [string, ...string[]]),
    testResults: TestResultsSchema,
    changedFiles: z.array(z.string()),
  })
  .strict();

const FailureSchema = z
  .object({ code: z.string().min(1), message: z.string(), remediation: z.string() })
  .strict();

/**
 * `.strict()` is the DOD's "an undeclared field is rejected by the report layer
 * rather than silently written" — the rejection is structural, not a review
 * habit.
 */
const EvidenceSchema = z
  .object({
    reverifyId: z.string().min(1),
    runId: z.string().min(1),
    requestId: z.string().min(1),
    headSha: z.string().min(1),
    baseSha: z.string().min(1),
    startedAt: z.string().min(1),
    completedAt: z.string().min(1),
    durationMs: z.number().int().min(0),
    checks: z.array(GateCheckSchema),
    testResults: TestResultsSchema,
    flags: z.array(z.string()),
    discrepancies: z.array(z.string()),
    claimed: ClaimedSchema.nullable(),
    toolchain: z.record(z.string(), z.string()),
    timings: TimingsSchema,
    failure: FailureSchema.optional(),
    nondeterministic: z.boolean().optional(),
    /**
     * The repository genuinely has no test suite, DECLARED HOST-SIDE in
     * `.factory/pipeline.json`. The only thing that suppresses
     * `no-tests-executed`, and the tree — the half an agent controls — can
     * never assert it. The plan then carries the non-test checks, and the
     * green still requires at least one of them.
     */
    noTestSuite: z.boolean().optional(),
  })
  .strict();

export type ReverifyEvidence = z.input<typeof EvidenceSchema> & {
  checks: GateCheck[];
};

export interface ReverifyReport {
  readonly reverifyId: string;
  readonly runId: string;
  readonly requestId: string;
  readonly headSha: string;
  readonly baseSha: string;
  readonly verdict: ReverifyVerdict;
  readonly reason?: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly durationMs: number;
  readonly checks: readonly Readonly<GateCheck>[];
  readonly testResults: Readonly<{ passed: number; failed: number }>;
  readonly flags: readonly string[];
  readonly discrepancies: readonly string[];
  readonly claimed: Readonly<{
    exitStatus: string;
    testResults: { passed: number; failed: number };
    changedFiles: string[];
  }> | null;
  readonly toolchain: Readonly<Record<string, string>>;
  readonly timings: Readonly<{
    worktree_ms: number;
    install_ms: number;
    tests_ms: number;
    gates_ms: number;
    cleanup_ms: number;
  }>;
  readonly failure?: Readonly<{ code: string; message: string; remediation: string }>;
}

/** `redactSecrets` ignores keys its heuristic does not recognise — refuse those loudly. */
function assertRedactable(map: RedactionMap): void {
  for (const [key, value] of Object.entries(map)) {
    if (value.length < 8) continue; // below redactSecrets' floor; nothing to promise
    if (!/SECRET|TOKEN|PASS|CRED|API[_-]?KEY|PRIVATE|CERT|DSN|DATABASE_URL|SSH|SIGNING|AUTH|[_-]KEY|[_-]URL|[_-]URI/i.test(key)) {
      throw new Error(
        `redaction map key ${key} is invisible to redactSecrets; name it so it matches SECRET_KEY_RE (e.g. QDS_PROVIDER_KEY)`,
      );
    }
  }
}

/**
 * Redact FIRST, then truncate — a secret straddling the cut no longer matches
 * the full-value pattern, so truncating first would leak its suffix
 * (`command-gate.ts` INV-2, same reasoning).
 */
function scrub(text: string, map: RedactionMap): string {
  const redacted = redactSecrets(text, map);
  if (redacted.length <= NOTE_MAX_CHARS) return redacted;
  const suffix = `…[truncated, ${redacted.length} chars total]`;
  return `${redacted.slice(0, Math.max(0, NOTE_MAX_CHARS - suffix.length))}${suffix}`;
}

/**
 * The one place a verdict comes from.
 *
 * Order matters and is fail-closed: a failure outranks everything (an `error`
 * is never a `green`), an empty check set or an unexecuted suite is `red`
 * before any pass can be counted, and a green requires BOTH a completed test
 * result and at least one recorded check. `claimed` is not consulted — an
 * in-box claim can neither raise nor lower a host verdict (AC3, INV-RV-1).
 */
function deriveVerdict(ev: z.output<typeof EvidenceSchema>): { verdict: ReverifyVerdict; reason?: string } {
  if (ev.failure) return { verdict: "error", reason: ev.failure.code };
  if (ev.checks.length === 0) return { verdict: "red", reason: "nothing-to-verify" };
  if (!ev.noTestSuite && ev.testResults.passed + ev.testResults.failed === 0) {
    return { verdict: "red", reason: "no-tests-executed" };
  }
  if (ev.nondeterministic) return { verdict: "red", reason: "nondeterministic" };
  if (ev.testResults.failed > 0) return { verdict: "red", reason: "tests-failed" };
  const failedCheck = ev.checks.find((c) => !c.ok);
  if (failedCheck) return { verdict: "red", reason: `gate-failed: ${failedCheck.item}` };
  return { verdict: "green" };
}

/**
 * Validate the evidence, redact it against the run's own secret map, cap it,
 * derive the verdict and freeze the result. The returned object is the only
 * `ReverifyReport` shape that exists.
 */
export function sealReport(evidence: ReverifyEvidence, redaction: RedactionMap): ReverifyReport {
  assertRedactable(redaction);
  const parsed = EvidenceSchema.parse(evidence);

  const flags = [...parsed.flags];
  const truncated = parsed.checks.length > CHECKS_MAX;
  if (truncated && !flags.includes("checks-truncated")) flags.push("checks-truncated");
  if (parsed.nondeterministic && !flags.includes("nondeterministic")) flags.push("nondeterministic");

  const checks = parsed.checks
    .slice(0, CHECKS_MAX)
    .map((c) => Object.freeze({ item: c.item, ok: c.ok, note: scrub(c.note, redaction) }));

  const { verdict, reason } = deriveVerdict(parsed);

  // The exitStatus comparison lives HERE because it is the one discrepancy that
  // needs the verdict, and the verdict exists nowhere else. Recording it is all
  // it does: a box claim can neither raise nor lower a host verdict (AC3).
  const discrepancies = [...parsed.discrepancies];
  if (parsed.claimed !== null) {
    const boxSucceeded = parsed.claimed.exitStatus === "success";
    if (boxSucceeded !== (verdict === "green")) {
      discrepancies.push(`exitStatus: claimed ${JSON.stringify(parsed.claimed.exitStatus)}, host verdict ${verdict}`);
    }
  }

  const report: ReverifyReport = {
    reverifyId: parsed.reverifyId,
    runId: parsed.runId,
    requestId: parsed.requestId,
    headSha: parsed.headSha,
    baseSha: parsed.baseSha,
    verdict,
    ...(reason !== undefined ? { reason } : {}),
    startedAt: parsed.startedAt,
    completedAt: parsed.completedAt,
    durationMs: parsed.durationMs,
    checks: Object.freeze(checks),
    testResults: Object.freeze({ ...parsed.testResults }),
    flags: Object.freeze(flags.map((f) => scrub(f, redaction))),
    discrepancies: Object.freeze(discrepancies.map((d) => scrub(d, redaction))),
    claimed: parsed.claimed === null ? null : Object.freeze(structuredClone(parsed.claimed)),
    toolchain: Object.freeze({ ...parsed.toolchain }),
    timings: Object.freeze({ ...parsed.timings }),
    ...(parsed.failure
      ? {
          failure: Object.freeze({
            code: parsed.failure.code,
            message: scrub(parsed.failure.message, redaction),
            remediation: scrub(parsed.failure.remediation, redaction),
          }),
        }
      : {}),
  };
  return Object.freeze(report);
}

export const DEFAULT_REVERIFY_DIR = ".sandbox/reverify";

export function reportPath(dir: string, runId: string): string {
  return join(dir, `${runId}.jsonl`);
}

/** Append-only: one JSON object per line, never a rewrite of an earlier line. */
export function appendReport(dir: string, report: ReverifyReport): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  appendFileSync(reportPath(dir, report.runId), `${JSON.stringify(report)}\n`, { mode: 0o600 });
}

/** Every report for a run, in write order. The LAST is authoritative (DF5.2). */
export function readReports(dir: string, runId: string): ReverifyReport[] {
  let text: string;
  try {
    text = readFileSync(reportPath(dir, runId), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  return text
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as ReverifyReport);
}
