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

import { MIN_REDACTABLE_VALUE_LEN, SECRET_KEY_RE, redactSecrets } from "../../cli-anything/src/redact.ts";
import type { GateCheck } from "../phase-engine/gates/report.ts";
import { EXIT_STATUSES } from "../../cli-anything/src/types.ts";
import { log, newRequestId } from "../lib/log.ts";

/** Per-check evidence cap, suffix INCLUDED (story: Guards/limits). */
export const NOTE_MAX_CHARS = 1_000;
/** Hard cap on examined items carried in one report. */
export const CHECKS_MAX = 500;
/** Hard cap on box-claimed paths carried in one report (they are untrusted). */
export const CLAIMED_FILES_MAX = 500;

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

/**
 * The report AS READ BACK. `sealReport` validates on the way in; this is the
 * way out — `readReports` feeds `preflight`, which decides whether a
 * credential reaches git on `verdict`/`headSha`/`reverifyId`/`completedAt`.
 * A file anyone can append to is a trust boundary in both directions.
 *
 * Derived from `EvidenceSchema` so the two can never drift: the evidence-only
 * knobs are omitted, the derived verdict/reason added.
 */
export const ReverifyReportSchema = EvidenceSchema.omit({
  nondeterministic: true,
  noTestSuite: true,
})
  .extend({
    verdict: z.enum(["green", "red", "error"]),
    reason: z.string().optional(),
  })
  .strict();

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

/**
 * `redactSecrets` ignores keys its heuristic does not recognise — refuse those
 * loudly.
 *
 * Exported because the report is not the only PUBLICATION surface: DF5.2
 * renders the same run's redaction map into a PR body and an issue comment,
 * and a key that is invisible here is invisible there too.
 */
export function assertRedactable(map: RedactionMap): void {
  for (const [key, value] of Object.entries(map)) {
    // Below redactSecrets' own floor; nothing to promise. Both the floor and
    // the key pattern are IMPORTED, never re-spelled: a local copy silently
    // stops matching the moment redact.ts widens either one.
    if (value.length < MIN_REDACTABLE_VALUE_LEN) continue;
    if (!SECRET_KEY_RE.test(key)) {
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

  // The box wrote `claimed`. Every string in it is agent-controlled and DF5.2
  // renders it into a PR body, so it is scrubbed and capped exactly like a
  // check note (INV-RV-4) — the counts and the enum'd exitStatus cannot carry a
  // secret, `changedFiles` can.
  const claimed =
    parsed.claimed === null
      ? null
      : Object.freeze({
          exitStatus: parsed.claimed.exitStatus,
          testResults: { ...parsed.claimed.testResults },
          changedFiles: parsed.claimed.changedFiles
            .slice(0, CLAIMED_FILES_MAX)
            .map((f) => scrub(f, redaction)),
        });
  if (
    parsed.claimed !== null &&
    parsed.claimed.changedFiles.length > CLAIMED_FILES_MAX &&
    !flags.includes("claimed-files-truncated")
  ) {
    flags.push("claimed-files-truncated");
  }

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
    claimed,
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

/**
 * Every report for a run, in write order, PLUS whether the final non-blank line
 * was dropped.
 *
 * Skipping is right for the nondeterminism heuristic (`runner.ts`), which is
 * comparing history: one torn line (a killed append) must not turn a completed
 * re-verify into an uncaught throw with no report on disk at all.
 *
 * Skipping is WRONG at the push boundary. "The LAST record is authoritative"
 * (DF5.2) inverts the moment the last line is the dropped one: `reports.at(-1)`
 * then hands `preflight` an EARLIER report, and an earlier green authorizes a
 * push the current, unreadable verdict never did. So the tail is reported
 * separately and `preflight` refuses on it — see `push.ts`.
 */
export function readReportsWithTail(
  dir: string,
  runId: string,
): { reports: ReverifyReport[]; lastLineInvalid: boolean } {
  const file = reportPath(dir, runId);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { reports: [], lastLineInvalid: false };
    throw e;
  }
  const out: ReverifyReport[] = [];
  let lastLineInvalid = false;
  const lines = text.split("\n");
  for (const [i, line] of lines.entries()) {
    if (line.trim().length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      lastLineInvalid = true;
      emitLineDropped(file, i + 1, "unparsable");
      continue;
    }
    // Parsing is not trusting: a line that is valid JSON but not a report is
    // dropped exactly like a torn one, rather than reaching preflight with
    // `verdict` undefined or attacker-chosen.
    const checked = ReverifyReportSchema.safeParse(parsed);
    if (checked.success) {
      out.push(checked.data as ReverifyReport);
      lastLineInvalid = false;
    } else {
      lastLineInvalid = true;
      emitLineDropped(file, i + 1, checked.error.issues[0]?.path.join(".") || "schema");
    }
  }
  return { reports: out, lastLineInvalid };
}

/**
 * A dropped line is a silent hole in an append-only audit file, so it is named
 * once. Guarded like `quota.ts`'s absent-config line: a raising sink must not
 * convert a torn line into a thrown read.
 */
function emitLineDropped(file: string, lineIndex: number, why: string): void {
  try {
    log({
      requestId: newRequestId(),
      operation: "reverify.report.read",
      agentId: null,
      timestamp: new Date().toISOString(),
      duration: 0,
      status: "error",
      code: "reverify-report-line-unparsable",
      reportFile: file,
      // 1-based: the line an editor opening this file will show.
      lineIndex,
      message: `dropped line ${lineIndex} of ${file} (${why}) — it is not a ReverifyReport`,
    });
  } catch {
    // best-effort signal only; the skip stands either way
  }
}

/** Every report for a run, in write order. The LAST is authoritative (DF5.2). */
export function readReports(dir: string, runId: string): ReverifyReport[] {
  return readReportsWithTail(dir, runId).reports;
}
