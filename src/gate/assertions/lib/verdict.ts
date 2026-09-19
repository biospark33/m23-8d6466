/**
 * Shared shell for the verifier-backed clause assertions (p0-5, p0-6, ...).
 *
 * Both modules independently answer the same three questions before they
 * ever look at clause-specific evidence: is the run usable at all, are the
 * required ACs present in the verdict, and is each one individually green?
 * That triplet is exactly where p0-6 hardened itself (asserting specific
 * evidence keys instead of a bare `status === "pass"`) while p0-5 initially
 * had not — the two modules are structurally identical peers, so the next
 * hardening fix landing in only one of them is the mechanism by which they
 * drift apart. This hoists the shared part; the evidence-specific guards
 * (p0-5's numeric warningCount vs p0-6's two boolean flags) stay in each
 * module, since those genuinely differ and should not be flattened.
 */
import * as fs from "node:fs";
import type { GateCheckOutcome } from "../../gate-runner.ts";
import { findCheck, verifierUnusable, type VerifierCheck, type VerifierRun } from "../../verifier-child.ts";

export interface RequiredAcsResult {
  /** One entry per AC asked for; undefined when that check was absent. */
  checks: Record<string, VerifierCheck | undefined>;
  /** "no <AC> check in verdict" / "<AC> status=<status>: <reason>" per AC. Empty when every AC is present and green. */
  failures: string[];
}

/** True when `checkRequiredAcs` already produced a final outcome (run unusable). */
export function isOutcome(x: RequiredAcsResult | GateCheckOutcome): x is GateCheckOutcome {
  return "pass" in x;
}

/**
 * Confirms the run is usable, then checks that each requested AC is present
 * and its own status is "pass". Callers layer clause-specific evidence guards
 * on top of `failures`/`checks` before deciding the final verdict.
 */
export function checkRequiredAcs(run: VerifierRun, acs: readonly string[]): RequiredAcsResult | GateCheckOutcome {
  const unusable = verifierUnusable(run);
  if (unusable) return { pass: false, skip: true, detail: unusable };

  const failures: string[] = [];
  const checks: Record<string, VerifierCheck | undefined> = {};
  for (const ac of acs) {
    const found = findCheck(run, ac);
    checks[ac] = found;
    if (!found) {
      failures.push(`no ${ac} check in verdict`);
    } else if (found.status !== "pass") {
      failures.push(`${ac} status=${found.status}: ${found.reason ?? "no reason given"}`);
    }
  }
  return { checks, failures };
}

// ---------------------------------------------------------------------------
// DF5.4 lights-on-gate helpers (leaf-1.1.1, additive — the exports above are
// untouched). Pure shared primitives for the DF5.4 assertion modules; each one
// exists so a specific false-green class cannot reappear per-module:
// scanNdjson drops no line, strictBeforeMs never compares across time bases,
// selectBoundReport cannot bind an approval to a superseded report, and
// readJsonEvidence never reports a read failure as evidence.
// ---------------------------------------------------------------------------

/** One NDJSON scan outcome: every line classified, none silently dropped. */
export interface NdjsonScan {
  wellFormed: unknown[];
  malformed: Array<{ line: number; error: string }>;
}

/**
 * Classifies every non-empty line of an NDJSON text (1-based line numbers):
 * lines that parse to a JSON object land in `wellFormed`, everything else in
 * `malformed` — a parse failure carries the parser's message, a parsed scalar
 * or `null` carries "not a JSON object". Blank/whitespace-only lines are
 * ignored, and a leading UTF-8 BOM is stripped so it cannot malform line 1.
 * Empty text yields both arrays empty.
 */
export function scanNdjson(text: string): NdjsonScan {
  const scan: NdjsonScan = { wellFormed: [], malformed: [] };
  const bomless = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const lines = bomless.split(/\r?\n/);
  for (const [i, line] of lines.entries()) {
    if (line.trim() === "") continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed !== null && typeof parsed === "object") {
        scan.wellFormed.push(parsed);
      } else {
        scan.malformed.push({ line: i + 1, error: "not a JSON object" });
      }
    } catch (error) {
      scan.malformed.push({
        line: i + 1,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return scan;
}

/**
 * Canonical-ISO strict ordering delta in ms (`b` minus `a`): returns null
 * when either stamp is not a canonical ISO-8601 instant (chain.ts `msOf`
 * precedent), so the caller decides skip vs fail instead of comparing across
 * time bases. Equality yields 0; F10 callers treat <= 0 as a violation.
 *
 * Canonical here means the stamp re-spells `toISOString()` exactly, or the
 * same instant with its (necessarily .000) milliseconds elided —
 * "2026-09-18T02:49:54Z" round-trips because `toISOString()` always emits
 * milliseconds and both spellings name the same instant.
 */
export function strictBeforeMs(a: string, b: string): number | null {
  const canonicalMs = (stamp: string): number | null => {
    const parsed = Date.parse(stamp);
    if (!Number.isFinite(parsed)) return null;
    const iso = new Date(parsed).toISOString();
    return iso === stamp || iso === stamp.replace(/Z$/, ".000Z") ? parsed : null;
  };
  const msA = canonicalMs(a);
  const msB = canonicalMs(b);
  if (msA === null || msB === null) return null;
  return msB - msA;
}

/**
 * Selects the bound report — the one whose `reverifyId` equals
 * `approval.reportId`, never an id listed in `supersededReportIds` — so C6/C7
 * share one selection and cannot drift. Returns the report, or a typed
 * failure reason, checked in this order: `bound-report-superseded:<id>` (the
 * bound id was superseded — before any lookup, so a missing line cannot mask
 * it), `bound-report-absent:<id>:<path>` (no line resolves) or
 * `bound-report-duplicate:<id>:<path>` (more than one line resolves — on an
 * append-only file anyone can write, first-wins would verify an arbitrary
 * line).
 */
export function selectBoundReport<Report extends { reverifyId: string }>(
  reports: ReadonlyArray<Report>,
  approval: { reportId: string; supersededReportIds: string[] },
  path: string,
): { report: Report } | { reason: string } {
  if (approval.supersededReportIds.includes(approval.reportId)) {
    return { reason: `bound-report-superseded:${approval.reportId}` };
  }
  const matches = reports.filter((r) => r.reverifyId === approval.reportId);
  if (matches.length === 0) return { reason: `bound-report-absent:${approval.reportId}:${path}` };
  if (matches.length > 1) return { reason: `bound-report-duplicate:${approval.reportId}:${path}` };
  // length === 1 is proven above; the cast carries that proof.
  return { report: matches[0] as Report };
}

/**
 * Reads and JSON.parses a file, returning undefined on any read or parse
 * failure (p0-2 `readJson` pattern, promoted shared for DF5.4 evidence).
 */
export function readJsonEvidence(file: string): unknown | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

/**
 * Same read+parse as `readJsonEvidence`, but callers that phrase their detail
 * from the failure MODE get it: a read failure (the file vanished, chmoded or
 * became unreadable between an existence check and the read) is a different
 * sentence than a parse failure (bytes arrived but are not JSON). The read
 * arm keeps the raw fs message (syscall + path — the path is the operator's
 * own evidence location, deliberately named in provenance); the parse arm is
 * FIXED TEXT, because parser messages can echo fragments of the file's bytes
 * and the evidence is untrusted disk data (INV-GATE-2: a detail must never
 * become a channel for file content). Pure additive sibling —
 * `readJsonEvidence` and its callers are untouched.
 */
export type JsonEvidenceRead =
  | { ok: true; value: unknown }
  | { ok: false; kind: "read" | "parse"; error: string };

export function readJsonEvidenceDiagnosed(file: string): JsonEvidenceRead {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    return { ok: false, kind: "read", error: error instanceof Error ? error.message : String(error) };
  }
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, kind: "parse", error: "bytes are not a JSON document" };
  }
}
