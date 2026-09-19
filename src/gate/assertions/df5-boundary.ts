/**
 * DF5.4 lights-on gate — boundary clauses C5–C8 (leaf-1.1.4).
 *
 * The four clauses past the run's execution edge: DF2.5's bundle ref, DF5.1's
 * host-side re-verify ordering, DF3.4's approval and DF5.2's PR body. Every
 * one asserts HOST-side evidence from the frozen run of record (INV-GATE-4)
 * and nothing here mutates, dispatches or touches the network.
 *
 * C6 and C7 share one bound-report selection (`selectBoundReport` in
 * lib/verdict.ts): the report whose `reverifyId` equals
 * `extensions.approval.reportId`, NEVER the append-only jsonl's last line —
 * reading the last line can fail a lawfully-approved run whose final report is
 * red, or pass a run whose approval bound a superseded report, a truth layer
 * nothing approved. C5 resolves the sandbox ref ONLY in the `--git-dir` seam's
 * bare repo; the operator's working repo is never resolved (a live path
 * Guards/limits forbids, and one that would make AC3's determinism
 * machine-dependent). C7 reads `extensions.approval` and nothing else — there
 * is no `.sandbox/approvals/` file and there never was.
 *
 * Pure auditors are exported separately from the check closures (p0-3 module
 * pattern) so the clause contracts are testable rather than buried.
 */
import * as fs from "node:fs";
import { join } from "node:path";
import type { GateAssertion, GateCheckOutcome } from "../gate-runner.ts";
import { readReports, reportPath, type ReverifyReport } from "../../reverify/report.ts";
import { readJsonEvidence, selectBoundReport, strictBeforeMs } from "./lib/verdict.ts";

// ---------------------------------------------------------------------------
// Pure auditors
// ---------------------------------------------------------------------------

/** What `git rev-parse --verify` came back with (async Bun.spawn, never spawnSync). */
export interface BundleRefOutcome {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export interface BundleRefAudit {
  failures: string[];
  /** Trimmed stdout — the resolved object id, meaningful only on pass. */
  sha: string;
}

/** C5: the sandbox ref resolves to a valid object id in the seam's bare repo. */
export function auditBundleRef(
  outcome: BundleRefOutcome,
  ctx: { gitDir: string; ref: string },
): BundleRefAudit {
  const sha = outcome.stdout.trim();
  const failures: string[] = [];
  if (outcome.exitCode !== 0) {
    failures.push(
      `git --git-dir ${ctx.gitDir} rev-parse --verify ${ctx.ref} exited ${String(outcome.exitCode)}` +
        `: ${outcome.stderr.trim() || "no stderr"}`,
    );
  } else if (!/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(sha)) {
    failures.push(`rev-parse exited 0 but printed "${sha}" — not an object id`);
  }
  return { failures, sha };
}

export interface ReverifyOrderEvidence {
  /** Untrusted on purpose: the jsonl is an append-only file anyone can write. */
  verdict: unknown;
  rvCompletedAt: unknown;
  prCreatedAt: unknown;
}

/**
 * C6: the bound report is green AND its host `completedAt` is strictly before
 * DF5.2's host `extensions.pr.createdAt` (F10). `strictBeforeMs` returns null
 * on a non-canonical stamp — that is a FAIL naming the stamp, never a silent
 * false and never a comparison across time bases; GitHub's `created_at` is a
 * different clock and is never the ordering input. Equality is a violation.
 */
export function auditReverifyOrder(ev: ReverifyOrderEvidence): { failures: string[] } {
  const failures: string[] = [];
  if (ev.verdict !== "green") {
    failures.push(`bound report verdict=${String(ev.verdict)} (expected "green")`);
  }
  if (typeof ev.rvCompletedAt !== "string" || typeof ev.prCreatedAt !== "string") {
    failures.push(
      `ordering stamps must be strings (rvCompletedAt=${String(ev.rvCompletedAt)}, ` +
        `prCreatedAt=${String(ev.prCreatedAt)})`,
    );
    return { failures };
  }
  const delta = strictBeforeMs(ev.rvCompletedAt, ev.prCreatedAt);
  if (delta === null) {
    failures.push(
      `non-canonical ISO stamp — re-verify/PR cannot be ordered across time bases (rvCompletedAt=${ev.rvCompletedAt}, prCreatedAt=${ev.prCreatedAt})`,
    );
  } else if (delta <= 0) {
    failures.push(
      `F10 violation: bound ReverifyReport.completedAt (${ev.rvCompletedAt}) is not strictly ` +
        `before extensions.pr.createdAt (${ev.prCreatedAt}) — delta ${delta}ms (equality is a violation)`,
    );
  }
  return { failures };
}

export interface ApprovalEvidence {
  /** Untrusted on purpose: `extensions.approval` off the on-disk run record. */
  approval: unknown;
  /** The BOUND report's completedAt (C6's selection discipline, shared). */
  boundCompletedAt: unknown;
  prCreatedAt: unknown;
}

/**
 * C7: `extensions.approval` carries a terminal `state: "approved"` with
 * `approverId` and `decidedAt`, and the ordering holds —
 * bound.completedAt < decidedAt < pr.createdAt, all strict, host clocks only.
 * An absent/malformed approval FAILS (INV-GATE-5 positive assertion); there is
 * no `.sandbox/approvals/` fallback because there is no such file and never was.
 */
export function auditApproval(ev: ApprovalEvidence): { failures: string[] } {
  const failures: string[] = [];
  const approval = ev.approval;
  if (typeof approval !== "object" || approval === null) {
    failures.push(
      "no extensions.approval on the run record — approval lives only in the DF2.1-registered " +
        "extensions.approval namespace (there is no .sandbox/approvals/ file and never was)",
    );
    return { failures };
  }
  const fields = approval as Record<string, unknown>;
  if (fields.state !== "approved") {
    failures.push(`extensions.approval.state=${String(fields.state)} (expected terminal "approved")`);
  }
  if (typeof fields.approverId !== "string" || fields.approverId.length === 0) {
    failures.push("extensions.approval.approverId missing/empty");
  }
  const decidedAt = fields.decidedAt;
  if (typeof decidedAt !== "string" || decidedAt.length === 0) {
    failures.push("extensions.approval.decidedAt missing/empty");
    return { failures };
  }
  if (typeof ev.boundCompletedAt !== "string" || typeof ev.prCreatedAt !== "string") {
    failures.push(
      `ordering stamps must be strings (boundCompletedAt=${String(ev.boundCompletedAt)}, ` +
        `prCreatedAt=${String(ev.prCreatedAt)})`,
    );
    return { failures };
  }
  // Same strict, host-clock-only discipline C6 applies on the other side of
  // the decision. A null from strictBeforeMs names the non-canonical stamp.
  const afterReverify = strictBeforeMs(ev.boundCompletedAt, decidedAt);
  if (afterReverify === null) {
    failures.push(
      `non-canonical ISO stamp — cannot order (boundCompletedAt=${ev.boundCompletedAt}, decidedAt=${decidedAt})`,
    );
  } else if (afterReverify <= 0) {
    failures.push(
      `F10 violation: bound ReverifyReport.completedAt (${ev.boundCompletedAt}) is not strictly ` +
        `before approval.decidedAt (${decidedAt}) — delta ${afterReverify}ms`,
    );
  }
  const beforePr = strictBeforeMs(decidedAt, ev.prCreatedAt);
  if (beforePr === null) {
    failures.push(`non-canonical ISO stamp — cannot order (decidedAt=${decidedAt}, prCreatedAt=${ev.prCreatedAt})`);
  } else if (beforePr <= 0) {
    failures.push(
      `F10 violation: approval.decidedAt (${decidedAt}) is not strictly before ` +
        `extensions.pr.createdAt (${ev.prCreatedAt}) — delta ${beforePr}ms`,
    );
  }
  return { failures };
}

/**
 * C8: the PR body's SHAPE, never P1.3's mapping quality. Pinned exactly:
 *  - the runId appears somewhere in the body;
 *  - a line matching /^Issue:\s*\S+ — a labelled line with a non-empty value.
 *    The literal `unresolved` is explicitly acceptable (DF5.2 AC2); whether a
 *    non-`unresolved` value is actually RESOLVED is the mirror index's concern
 *    (out of the v5 slate), so the shape stops at "non-empty value";
 *  - a cost summary line: a line containing "cost" (case-insensitive) and a digit.
 */
export function auditPrBody(text: string, runId: string): { failures: string[] } {
  const failures: string[] = [];
  const lines = text.split(/\r?\n/);
  if (!text.includes(runId)) {
    failures.push(`runId ${runId} absent from body`);
  }
  if (!lines.some((line) => /^Issue:\s*\S+/.test(line))) {
    failures.push(
      'no "Issue:" line — body must carry one whose value is a resolved reference or the literal "unresolved"',
    );
  }
  if (!lines.some((line) => /cost/i.test(line) && /\d/.test(line))) {
    failures.push('no cost summary line (a line containing "cost" and a digit)');
  }
  return { failures };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface Df5BoundaryDeps {
  runId: string;
  runsDir: string;
  /** Bare repo carrying refs/sandbox/<runId> and its objects (the --git-dir seam). */
  gitDir: string;
  reverifyDir: string;
  prBodyFile: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/**
 * C6/C7's shared evidence read. Everything narrows from `unknown` — the record
 * and the jsonl are untrusted on-disk evidence (p0-3 lesson: a drifted schema
 * must fail the clause, not crash past the type checker).
 */
interface BoundaryEvidence {
  recordOk: boolean;
  reports: ReverifyReport[];
  /** extensions.approval, when present and object-shaped. */
  approval?: Record<string, unknown>;
  prCreatedAt?: unknown;
  /** Bound-report selection; a reason when the approval shape is unusable. */
  bound?: { report: ReverifyReport } | { reason: string };
}

function loadEvidence(deps: Df5BoundaryDeps, recordFile: string, rvFile: string): BoundaryEvidence {
  const record = readJsonEvidence(recordFile);
  const recordOk = isRecord(record);
  let reports: ReverifyReport[] = [];
  try {
    reports = readReports(deps.reverifyDir, deps.runId);
  } catch {
    // Non-ENOENT read failure (readReports rethrows those): unreadable
    // evidence is skip, and the caller treats an empty list as exactly that.
  }
  const evidence: BoundaryEvidence = { recordOk, reports };
  if (!recordOk) return evidence;

  const extensions = isRecord(record.extensions) ? record.extensions : {};
  if (isRecord(extensions.approval)) evidence.approval = extensions.approval;
  if (isRecord(extensions.pr)) evidence.prCreatedAt = extensions.pr.createdAt;

  const { approval } = evidence;
  if (
    approval !== undefined &&
    typeof approval.reportId === "string" &&
    Array.isArray(approval.supersededReportIds) &&
    approval.supersededReportIds.every((x) => typeof x === "string")
  ) {
    evidence.bound = selectBoundReport(reports, {
      reportId: approval.reportId,
      // every()-guard above proves the element type; the single cast carries
      // that proof, it does not erase a compiler check.
      supersededReportIds: approval.supersededReportIds as string[],
    }, rvFile);
  } else {
    evidence.bound = {
      reason: `extensions.approval carries no usable reportId/supersededReportIds (${recordFile})`,
    };
  }
  return evidence;
}

export function df5BoundaryAssertions(deps: Df5BoundaryDeps): GateAssertion[] {
  const recordFile = join(deps.runsDir, `${deps.runId}.json`);
  const rvFile = reportPath(deps.reverifyDir, deps.runId);
  const ref = `refs/sandbox/${deps.runId}`;
  const skip = (detail: string): GateCheckOutcome => ({ pass: false, skip: true, detail });

  return [
    {
      id: "DF5.4-C5",
      story: "DF2.5",
      prd_clause: "§8 step 5 — bundle",
      description:
        "refs/sandbox/<run-id> resolves in the frozen fixture's bare repo (--git-dir seam) — " +
        "the operator's working repo is never touched",
      group: "main",
      check: async () => { // dp:ok — the chassis folds a thrown check into a named FAIL ("check threw"); git spawn ENOENT is a red gate, correctly
        const proc = Bun.spawn(["git", "--git-dir", deps.gitDir, "rev-parse", "--verify", ref], {
          stdout: "pipe",
          stderr: "pipe",
        });
        const [stdout, stderr] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
        ]);
        const exitCode = await proc.exited;
        const { failures, sha } = auditBundleRef({ exitCode, stdout, stderr }, { gitDir: deps.gitDir, ref });
        const provenance = `ref ${ref} in --git-dir ${deps.gitDir} (frozen fixture bare repo; the operator's working repo is never resolved)`;
        return failures.length > 0
          ? { pass: false, detail: `${failures.join("; ")} — ${provenance}` }
          : { pass: true, detail: `${ref} → ${sha} — ${provenance}` };
      },
    },
    {
      id: "DF5.4-C6",
      story: "DF5.1",
      prd_clause: "§8 step 5 — host-side re-verify",
      description:
        "the bound ReverifyReport is green and its host completedAt is strictly before " +
        "extensions.pr.createdAt (F10, host clocks only)",
      group: "main",
      check: async () => {
        const ev = loadEvidence(deps, recordFile, rvFile);
        if (!ev.recordOk) return skip(`run record unreadable: ${recordFile}`);
        if (ev.reports.length === 0) {
          return skip(`no reverify reports at ${rvFile} (unreadable evidence is skip, not fail)`);
        }
        const bound = ev.bound;
        if (!bound || "reason" in bound) {
          return skip(`bound report not selectable: ${bound ? bound.reason : "unselected"} — ${rvFile}`);
        }
        const { failures } = auditReverifyOrder({
          verdict: bound.report.verdict,
          rvCompletedAt: bound.report.completedAt,
          prCreatedAt: ev.prCreatedAt,
        });
        const provenance = `bound report ${bound.report.reverifyId} from ${rvFile} (bound via extensions.approval.reportId — never the jsonl last line); PR stamp from ${recordFile} (host clock, never GitHub's created_at)`;
        return failures.length > 0
          ? { pass: false, detail: `${failures.join("; ")} — ${provenance}` }
          : {
              pass: true,
              detail: `bound report green, completedAt=${bound.report.completedAt} strictly precedes PR creation — ${provenance}`,
            };
      },
    },
    {
      id: "DF5.4-C7",
      story: "DF3.4",
      prd_clause: "§8 step 5 — approval",
      description:
        "extensions.approval is terminal approved with approverId/decidedAt, ordered " +
        "bound.completedAt < decidedAt < pr.createdAt — all strict, host clocks only",
      group: "main",
      check: async () => {
        const ev = loadEvidence(deps, recordFile, rvFile);
        if (!ev.recordOk) return skip(`run record unreadable: ${recordFile}`);
        // Read from extensions.approval ONLY: an approval-shaped file under
        // .sandbox/approvals/ neither exists nor substitutes (DoD negative control).
        if (ev.approval === undefined) {
          const { failures } = auditApproval({
            approval: undefined,
            boundCompletedAt: undefined,
            prCreatedAt: undefined,
          });
          return { pass: false, detail: `${failures.join("; ")} — ${recordFile}` };
        }
        if (ev.reports.length === 0) {
          return skip(`C7 ordering input gone: no reverify reports at ${rvFile}`);
        }
        const bound = ev.bound;
        if (!bound || "reason" in bound) {
          return skip(`bound report not selectable: ${bound ? bound.reason : "unselected"} — ${rvFile}`);
        }
        const { failures } = auditApproval({
          approval: ev.approval,
          boundCompletedAt: bound.report.completedAt,
          prCreatedAt: ev.prCreatedAt,
        });
        const provenance =
          `extensions.approval from ${recordFile}; bound report ${bound.report.reverifyId} ` +
          `from ${rvFile} (same selection discipline as C6)`;
        return failures.length > 0
          ? { pass: false, detail: `${failures.join("; ")} — ${provenance}` }
          : {
              pass: true,
              detail: `approved (decidedAt=${String(ev.approval.decidedAt)}) strictly between bound completedAt and PR creation — ${provenance}`,
            };
      },
    },
    {
      id: "DF5.4-C8",
      story: "DF5.2",
      prd_clause: "§8 step 5 — PR",
      description:
        "the frozen pr-body.txt carries the runId, a labelled Issue: line (resolved or " +
        '"unresolved") and a cost summary line — shape, never mapping quality',
      group: "main",
      check: async () => {
        let text: string;
        try {
          text = fs.readFileSync(deps.prBodyFile, "utf8");
        } catch {
          return skip(`frozen PR body unreadable: ${deps.prBodyFile}`);
        }
        const { failures } = auditPrBody(text, deps.runId);
        const provenance = `frozen body ${deps.prBodyFile} (captured at freeze time — no live GitHub read)`;
        return failures.length > 0
          ? { pass: false, detail: `${failures.join("; ")} — ${provenance}` }
          : { pass: true, detail: `runId, Issue: line and cost line present — ${provenance}` };
      },
    },
  ];
}
