/**
 * PRD §13 Phase-0 clause 2 and clause 8 (Story P0.11).
 *
 *  - Clause 2: "Run logs show >=2 named agents exchanging >=2 coms (or
 *    subprocess-RPC) messages."
 *  - Clause 8: "All six open questions OQ-1..6 are answered with a decision
 *    recorded (including any fallback taken)."
 *
 * Clause 2 is asserted against P0.2's frozen run of record rather than by
 * re-running `scripts/coms-smoke-test.ts`, which is a paid, network-bound run
 * of several minutes. The evidence file is a recording of a real live run, not
 * a mock — but the assertion detail says so explicitly rather than implying the
 * gate re-proved it. Re-running live is a deliberate non-goal for a gate that
 * must be safe to run repeatedly.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { GateAssertion } from "../gate-runner.ts";

/** OQ-1..6 — clause 8 names exactly these six. */
const REQUIRED_OQS = ["OQ-1", "OQ-2", "OQ-3", "OQ-4", "OQ-5", "OQ-6"] as const;

/**
 * Coerces an evidence field to a count, preserving NaN for malformed input.
 *
 * Use this only to DISPLAY the observed value. For any threshold decision use
 * `meetsMinCount`, which is NaN-safe by construction — see below.
 */
export function asCount(v: unknown): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : Number.NaN;
}

/**
 * The only sanctioned way to threshold an evidence count.
 *
 * `Number("n/a")` is NaN and `NaN < min` is **false**, so a naive `count < min`
 * check records no failure and lets a corrupt run-of-record SATISFY the clause
 * — a false green, the one outcome this gate must never produce. Expressing the
 * test as `>=` makes malformed input fail automatically, so the invariant is
 * enforced by this function rather than by every caller remembering to negate.
 *
 * Never write `asCount(x) < min` at a call site.
 */
export function meetsMinCount(raw: unknown, min: number): boolean {
  return asCount(raw) >= min;
}

export interface OqDecisionAudit {
  problems: string[];
  statuses: string[];
}

/**
 * Extracts Appendix D's decision table from the PRD and audits OQ-1..6.
 *
 * Exported so the clause-8 contract is testable rather than buried in a check.
 * Two subtleties that were both live bugs:
 *
 *  - The section is bounded at the next **H2**, not any `##`/`###`. Appendix D
 *    contains H3 subsections (D.1, D.2); stopping at the first `###` truncated
 *    the table and dropped OQ rows, producing false FAILURES.
 *  - Status matching is word-bounded. A bare /RESOLVED/ also matches
 *    "UNRESOLVED", so an explicitly unresolved OQ would have SATISFIED clause 8
 *    — a false green in the assertion that certifies the open questions were
 *    answered.
 */
export function auditOqDecisions(prdText: string, requiredOqs: readonly string[]): OqDecisionAudit {
  const problems: string[] = [];
  const statuses: string[] = [];

  const appendixIdx = prdText.indexOf("Appendix D — Phase-0 spike decision log");
  if (appendixIdx < 0) {
    return { problems: ["PRD Appendix D (spike decision log) not found"], statuses };
  }
  const rest = prdText.slice(appendixIdx);
  // H2 only — H3 subsections belong to Appendix D and must not end it.
  const endRel = rest.slice(1).search(/\n## /);
  const appendix = endRel >= 0 ? rest.slice(0, endRel + 1) : rest;

  for (const oq of requiredOqs) {
    const row = appendix
      .split("\n")
      .find((l) => l.trimStart().startsWith("|") && l.includes(`**${oq}**`));
    if (!row) {
      problems.push(`${oq}: no decision-log row in Appendix D`);
      continue;
    }
    // "| OQ | status | decision |" -> drop the leading/trailing empties.
    const cells = row.split("|").slice(1, -1).map((c) => c.trim());
    const status = cells[1] ?? "";
    const decision = cells[2] ?? "";
    if (!/\b(RESOLVED|BLOCKED)\b/i.test(status)) {
      problems.push(`${oq}: status cell records no RESOLVED/BLOCKED verdict`);
      continue;
    }
    if (decision.length < 20) {
      problems.push(`${oq}: status "${status}" but no recorded decision/fallback text`);
      continue;
    }
    statuses.push(`${oq}=${/\bRESOLVED\b/i.test(status) ? "RESOLVED" : "BLOCKED+fallback"}`);
  }

  return { problems, statuses };
}

function readJson(file: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed !== null && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

export function comsAssertions(repoRoot: string): GateAssertion[] {
  // Story files write these as `_research/...`; on disk they live under
  // _bmad-output/sprint-artifacts/_research/ — there is no repo-root _research/.
  const evidence = path.join(
    repoRoot,
    "_bmad-output",
    "sprint-artifacts",
    "_research",
    "oq-1-smoke-run-2026-07-14.json",
  );
  const prd = path.join(repoRoot, "_bmad-output", "planning-artifacts", "prd-qds-factory-v4.md");

  return [
    {
      id: "P0.2-coms-two-agents-two-messages",
      story: "P0.2",
      prd_clause: "§13 P0 clause 2",
      description: ">=2 named agents exchanged >=2 messages in the coms run of record",
      group: "main",
      check: async () => {
        if (!fs.existsSync(evidence)) {
          return { pass: false, detail: `coms run of record missing: ${evidence}` };
        }
        const run = readJson(evidence);
        if (!run) return { pass: false, detail: `coms run of record is not valid JSON: ${evidence}` };

        const agents = asCount(run.agents_registered);
        const messages = asCount(run.messages_exchanged);
        const strict = run.strict === true;
        const passed = run.pass === true;
        const waived = run.pass_with_waiver === true;

        // Clause 2 wants >=2 messages. The P0.2 story AC only demanded >=1, so
        // the clause is the stricter bar and is what the gate asserts.
        const failures: string[] = [];
        if (!passed) failures.push("run of record did not pass");
        if (waived) failures.push("run passed only with a waiver");
        if (!strict) failures.push("run was not strict-gated");
        if (!meetsMinCount(run.agents_registered, 2)) {
          failures.push(`agents_registered=${agents} (expected >=2)`);
        }
        if (!meetsMinCount(run.messages_exchanged, 2)) {
          failures.push(`messages_exchanged=${messages} (expected >=2)`);
        }

        const provenance = `evidence-of-record ${path.basename(evidence)} (recorded live run, not re-executed by this gate)`;
        return failures.length > 0
          ? { pass: false, detail: `${failures.join("; ")} — ${provenance}` }
          : {
              pass: true,
              detail: `agents=${agents}, messages=${messages}, strict, unwaived — ${provenance}`,
            };
      },
    },
    {
      id: "OQ-1-6-decisions-recorded",
      story: "P0.2",
      prd_clause: "§13 P0 clause 8",
      description: "All six open questions OQ-1..6 have a recorded decision (incl. fallback taken)",
      group: "main",
      check: async () => {
        if (!fs.existsSync(prd)) return { pass: false, detail: `PRD not found: ${prd}` };
        const text = fs.readFileSync(prd, "utf8");
        // Appendix D is the spike decision log; each OQ row must appear there
        // with a status and a decision, per clause 8's "decision recorded".
        // Clause 8 requires a DECISION, not a mention. See auditOqDecisions.
        const { problems, statuses } = auditOqDecisions(text, REQUIRED_OQS);

        return problems.length > 0
          ? { pass: false, detail: `clause 8 unmet — ${problems.join("; ")}` }
          : {
              pass: true,
              detail: `all six OQs carry a decision in PRD Appendix D (${statuses.join(", ")}); clause 8 explicitly permits a recorded fallback`,
            };
      },
    },
  ];
}
