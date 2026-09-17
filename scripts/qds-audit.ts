#!/usr/bin/env bun
/**
 * CLI: qds-audit — the operator surface of the audit chain walk (DF5.3).
 *
 * Usage:
 *   qds-audit <pr-url|qds/<run-id>|runId> [--json] [--runs-dir <dir>]
 *             [--audit-db <path>] [--ledger <path>] [--reverify-dir <dir>]
 *
 * Walks one merged PR (or its run) back through every host-side record that
 * authorized it: `walkAuditChain` resolves the ten hops per contributing
 * runId; this command renders them.
 *
 * Exit matrix (BINDING — CI and the DF5.4-C9 fixture harness branch on it):
 *   0  a ChainReport was produced and the chain is COMPLETE
 *   1  a ChainReport was produced and it is INCOMPLETE  (the ONLY source of 1)
 *   2  no report was produced: usage error, unresolvable ref, any
 *      `ChainWalkError`, or any other fault during the walk (a missing runs
 *      dir, a corrupt store, a `gh` read that throws). An environment fault
 *      must never be reported as "the audit chain is broken".
 *
 * `--json` prints the ChainReport and NOTHING else on stdout; every
 * observability line (the walker's per-hop lines plus one final verdict line
 * here — the walker already logs per hop, so this CLI adds only the verdict)
 * goes to stderr. That guarantee is installed by `run()` itself, not by the
 * `import.meta.main` bootstrap, because `run()` is exported for harnesses.
 * All four store paths are explicit seams: an operator (or the DF5.4-C9 frozen
 * fixture) points them at a fixture set and the walk never touches the
 * developer's own `.sandbox/`. Overriding only SOME of them is legal but
 * warned about — a fixture run record joined against a live ledger is a
 * confidently wrong verdict.
 *
 * INV-AUDIT-2 is the WALKER's duty: it decides which fields enter a hop's
 * `detail`, and `--json` serialises the report verbatim (DF5.4-C9 imports it,
 * so this renderer must not allow-list it). What this file adds is a NARROWING
 * for humans: `describeHop` prints `key_hash` and its 8-char prefix and no
 * other credential field, and it adds no field the walker did not carry.
 */

import { writeSync } from "node:fs";
import { resolve } from "node:path";

import {
  AUDIT_HOPS,
  ChainWalkError,
  chainVerdict,
  DEFAULT_AUDIT_DB_FILE,
  walkAuditChain,
  type ChainReport,
  type HopOutcome,
} from "../src/audit/index.ts";
import { DEFAULT_COST_LEDGER_FILE } from "../src/providers/cost-ledger.ts";
import { resolveRunsDir } from "../src/providers/run-record.ts";
import { DEFAULT_REVERIFY_DIR } from "../src/reverify/report.ts";
import { log, newRequestId, setLogSink } from "../src/swarmclaw/log.ts";
import { parseValueFlags, tokenizeArgs } from "./lib/cli-args.ts";

const USAGE =
  "Usage: qds-audit <pr-url|qds/<run-id>|runId> [--json] [--runs-dir <dir>] [--audit-db <path>] [--ledger <path>] [--reverify-dir <dir>]";

const HELP = [
  USAGE,
  "",
  "  <ref>                   a merged PR URL, its qds/<run-id> branch, or the bare run id",
  "",
  "  --json                  print the ChainReport on stdout and nothing else",
  "  --runs-dir <dir>        run-record directory (default $QDS_RUNS_DIR)",
  "  --audit-db <path>       audit-links store (default $QDS_AUDIT_DB or .sandbox/audit.db)",
  "  --ledger <path>         cost ledger (default $QDS_COST_LEDGER_FILE)",
  "  --reverify-dir <dir>    re-verify record directory (default .sandbox/reverify)",
  "",
];

const VALUE_FLAGS = ["--runs-dir", "--audit-db", "--ledger", "--reverify-dir"] as const;
const BOOL_FLAGS = ["--json"] as const;

export interface ParsedAuditArgs {
  ref: string;
  json: boolean;
  runsDir?: string;
  auditDb?: string;
  ledger?: string;
  reverifyDir?: string;
}

export function parseAuditArgs(argv: readonly string[]): ParsedAuditArgs {
  // rejectStraySingleDash: a single-dash token is never legal here (one
  // positional, no value starts with `-`). Without it `-j` / `-runs-dir=/fix`
  // are DROPPED and the walk silently falls back to the real store paths —
  // the exact failure the seams exist to prevent.
  const { positionals, flagTokens, bools } = tokenizeArgs(argv, {
    valueFlags: VALUE_FLAGS,
    boolFlags: BOOL_FLAGS,
    rejectStraySingleDash: true,
  });
  const seams: Partial<Record<"runsDir" | "auditDb" | "ledger" | "reverifyDir", string>> = {};
  const seen = new Set<string>();
  parseValueFlags(flagTokens, {
    flags: VALUE_FLAGS,
    onValue: (flag, value) => {
      // Last-wins on a repeated seam would audit a store the operator did not
      // name first. On an audit tool that is a correctness problem, not a
      // convenience.
      if (seen.has(flag)) throw new Error(`${flag} given more than once`);
      seen.add(flag);
      // Absolute: the value is reported back in the partial-seam warning and
      // compared against the defaults, both of which are absolute-ish paths.
      const p = resolve(value);
      if (flag === "--runs-dir") seams.runsDir = p;
      else if (flag === "--audit-db") seams.auditDb = p;
      else if (flag === "--ledger") seams.ledger = p;
      else if (flag === "--reverify-dir") seams.reverifyDir = p;
      else throw new Error(`unhandled value flag: ${flag}`); // VALUE_FLAGS grew without a branch
    },
    help: HELP,
  });
  // Exactly one ref. Checked AFTER the flag grammar so an unknown flag (or a
  // flag missing its value) is reported as itself instead of as a bad ref count.
  if (positionals.length !== 1) {
    throw new Error(
      positionals.length === 0
        ? "missing <pr-url|branch|runId>"
        : `expected exactly one ref, got ${positionals.length} (${positionals.join(", ")})`,
    );
  }
  return { ref: positionals[0] as string, json: bools.has("--json"), ...seams };
}

/**
 * Seams left at their default, with the path that default resolves to.
 * Mirrors `walkAuditChain`'s own fallback chain — if that moves, this moves.
 */
function seamFallbacks(args: ParsedAuditArgs): string[] {
  const fallen: string[] = [];
  if (args.runsDir === undefined) fallen.push(`--runs-dir → ${resolveRunsDir()}`);
  if (args.auditDb === undefined) fallen.push(`--audit-db → ${process.env.QDS_AUDIT_DB ?? DEFAULT_AUDIT_DB_FILE}`);
  if (args.ledger === undefined) {
    fallen.push(`--ledger → ${process.env.QDS_COST_LEDGER_FILE ?? DEFAULT_COST_LEDGER_FILE}`);
  }
  if (args.reverifyDir === undefined) fallen.push(`--reverify-dir → ${DEFAULT_REVERIFY_DIR}`);
  return fallen;
}

/** The human block for one hop outcome — every field the union actually carries. */
export function describeHop(out: HopOutcome): string[] {
  const lines = [`status: ${out.status}`];
  switch (out.status) {
    case "resolved": {
      lines.push(`subject: ${out.subjectId}`);
      if (out.evidencePath !== undefined) lines.push(`evidence: ${out.evidencePath}`);
      if (out.evidenceDigest !== undefined) lines.push(`digest: ${out.evidenceDigest}`);
      if (out.linkId !== undefined) lines.push(`link: #${out.linkId}`);
      if (out.keyHash !== undefined) {
        // INV-AUDIT-2 narrowing: the hash and its 8-char prefix — never key material.
        lines.push(`keyHash: ${out.keyHash}`, `keyHashPrefix: ${out.keyHashPrefix ?? out.keyHash.slice(0, 8)}`);
      }
      const detail = out.detail as Record<string, unknown> | undefined;
      if (typeof detail?.totalMicroUsd === "number") {
        lines.push(`totalMicroUsd: ${detail.totalMicroUsd}`, `perRole: ${JSON.stringify(detail.perRole)}`);
      }
      break;
    }
    case "void":
    case "not-applicable":
      lines.push(out.reason);
      break;
    case "evidence-not-harvested":
      lines.push(out.reason, `evidence: ${out.evidencePath}`);
      break;
    case "unlinked":
      lines.push(`emitter: ${out.emitter}`, out.diagnostic);
      break;
    case "evidence-mismatch":
      lines.push(`expected: ${out.expectedDigest}`, `actual: ${out.actualDigest}`, `evidence: ${out.evidencePath}`);
      // Singular hops (1/7/8) additionally name both subject ids when the
      // rewrite landed in the field that FORMS the subject id.
      if (out.expectedSubjectId !== undefined) lines.push(`expectedSubject: ${out.expectedSubjectId}`);
      if (out.actualSubjectId !== undefined) lines.push(`actualSubject: ${out.actualSubjectId}`);
      break;
    case "order-violation":
      // CONSTRAINT order: `earlier` is the event the constraint requires first.
      lines.push(`constraint: ${out.constraint}`, `earlier: ${out.earlier}`, `later: ${out.later}`);
      break;
    case "hop-timeout":
      // `budget` names WHICH ceiling was exhausted — a per-hop stall and a
      // whole-walk overrun are different operator actions.
      lines.push(`elapsed: ${out.elapsedMs}ms`, `ceiling: ${out.ceilingMs}ms`, `budget: ${out.budget}`);
      break;
    case "broken":
      lines.push(`expected: ${out.expected}`, `actual: ${out.actual}`, out.diagnostic);
      if (out.evidencePath !== undefined) lines.push(`evidence: ${out.evidencePath}`);
      break;
    default: {
      // A new HopOutcome status must not render as a bare status with its
      // payload dropped — fail the build instead.
      const unreachable: never = out;
      throw new Error(`unhandled hop outcome: ${JSON.stringify(unreachable)}`);
    }
  }
  return lines;
}

function printHuman(report: ChainReport, verdict: ReturnType<typeof chainVerdict>): void {
  for (const [runId, run] of Object.entries(report.runs)) {
    writeSync(1, `run ${runId}\n`);
    const hops = run.hops as Record<string, HopOutcome | undefined>;
    const printed = new Set<string>();
    const block = (hop: string, out: HopOutcome): void => {
      printed.add(hop);
      writeSync(1, `  ${hop} [${out.status}]\n`);
      for (const line of describeHop(out)) writeSync(1, `    ${line}\n`);
    };
    for (const hop of AUDIT_HOPS) {
      const out = hops[hop];
      if (out !== undefined) block(hop, out);
    }
    // Any hop the report carries that AUDIT_HOPS does not list: the verdict
    // line counts it, so it must be visible here too.
    for (const [hop, out] of Object.entries(hops)) {
      if (out !== undefined && !printed.has(hop)) block(hop, out);
    }
  }
  const where = `${report.ref}, ${report.refKind}`;
  if (verdict.complete) {
    writeSync(1, `chain: COMPLETE (${where})\n`);
    return;
  }
  // Deduped once and used for both the count and the list: two runs broken at
  // the same hop are one broken hop NAME, and the per-run blocks above already
  // show the occurrences.
  const brokenHops = [...new Set(verdict.brokenHops.map((h) => h.hop))];
  const detail = brokenHops.length > 0 ? `${brokenHops.length} broken hop(s): ${brokenHops.join(", ")}` : "no runs walked";
  writeSync(1, `chain: BROKEN (${where}; ${detail})\n`);
}

/**
 * `exitWithFailure`'s stderr block without its `process.exit`: every path out
 * of `run()` returns its code so the exit matrix can be driven in-process.
 */
function fail(prefix: string, lines: readonly string[]): 2 {
  writeSync(2, `${[prefix, ...lines.map((l) => `  - ${l}`)].join("\n")}\n`);
  return 2;
}

/**
 * Serializes the sink swap below. `setLogSink` is a MODULE-GLOBAL with a
 * save/restore discipline, so two overlapping `run()` calls interleave as
 * save(orig) · save(A) · restore(orig) · restore(A) — the first finisher
 * restores the sink the SECOND one displaced, and the caller's own sink is
 * gone for good while A's stderr writer stays installed after both returned.
 * `run` is exported precisely so a harness can drive it (and a harness driving
 * the exit matrix is exactly what runs two walks at once), so the window is
 * reachable from the API's intended use.
 *
 * ponytail: one global gate, not a per-argv one — the resource being guarded
 * IS global, and a walk is an operator-scale operation, not a hot path.
 */
let sinkGate: Promise<unknown> = Promise.resolve();

/**
 * Walk and render. RETURNS the exit code (see the matrix in the file header) —
 * it never terminates the process, so a harness can drive the matrix directly.
 */
export async function run(argv: readonly string[]): Promise<number> {
  const mine = sinkGate.then(async () => {
    // Structured logs to stderr so stdout carries only the command's output.
    // Installed here rather than under `import.meta.main`: `run` is exported
    // precisely so a harness can drive it, and the --json stdout guarantee must
    // hold for that caller too. writeSync, not process.stderr.write: the latter
    // is async for pipes/files and our caller may exit before it drains.
    const restoreSink = setLogSink((entry) => {
      writeSync(2, `${JSON.stringify(entry)}\n`);
    });
    try {
      return await walkAndRender(argv);
    } finally {
      restoreSink();
    }
  });
  // The GATE swallows the rejection (a failed walk must not wedge every later
  // one); the CALLER still gets `mine` verbatim, rejection and all.
  sinkGate = mine.catch(() => undefined);
  return mine;
}

async function walkAndRender(argv: readonly string[]): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    writeSync(1, HELP.join("\n"));
    return 0;
  }
  let args: ParsedAuditArgs;
  try {
    args = parseAuditArgs(argv);
  } catch (e) {
    return fail("!! usage error", [USAGE, (e as Error).message]);
  }
  const ref = args.ref;
  const startedAt = Date.now();
  const requestId = newRequestId();

  const fallen = seamFallbacks(args);
  if (fallen.length > 0 && fallen.length < VALUE_FLAGS.length) {
    // Some seams point at a fixture and some do not: the walk joins fixture
    // records against live stores. Legal (DF5.4-C9 may override a subset) but
    // never silent.
    log({
      requestId, operation: "audit-chain.seams", agentId: null,
      timestamp: new Date().toISOString(), duration: 0, status: "ok",
      warning: `seam(s) left at their default while others were overridden: ${fallen.join("; ")}`,
      ref,
    });
  }

  let report: ChainReport;
  try {
    report = await walkAuditChain(ref, {
      requestId,
      ...(args.runsDir !== undefined ? { runsDir: args.runsDir } : {}),
      ...(args.auditDb !== undefined ? { auditDb: args.auditDb } : {}),
      ...(args.ledger !== undefined ? { ledger: args.ledger } : {}),
      ...(args.reverifyDir !== undefined ? { reverifyDir: args.reverifyDir } : {}),
    });
  } catch (e) {
    // No report was produced — exit 2 for EVERY throwable, not just
    // ChainWalkError. Exit 1 means "the chain is broken"; an unreadable runs
    // dir or a `gh` read that threw is an environment fault, and conflating
    // the two is a false accusation against the PR under audit.
    const walkError = e instanceof ChainWalkError;
    const code = walkError ? (e as ChainWalkError).code : "walk-failed";
    const message = e instanceof Error ? e.message : String(e);
    const next = walkError
      ? (e as ChainWalkError).remediation
      : "the walk faulted before producing a report — fix the condition above and re-run (this is NOT a broken chain)";
    log({
      requestId, operation: "audit-chain.verdict", agentId: null,
      timestamp: new Date().toISOString(), duration: Date.now() - startedAt,
      status: "error", error: { code, message }, ref,
    });
    return fail(`!! ${code}`, [message, `next: ${next}`]);
  }

  const walked = chainVerdict(report);
  // Defence in depth on the walker's verdict: "I found no evidence" must never
  // render as "I verified every hop" — the shape a mis-pointed --runs-dir
  // produces. `chainVerdict` already requires at least one resolved hop; this
  // keeps the CLI's exit contract true even if that changes.
  const verdict = { ...walked, complete: walked.complete && Object.keys(report.runs).length > 0 };
  if (args.json) writeSync(1, `${JSON.stringify(report)}\n`);
  else printHuman(report, verdict);
  log({
    requestId, operation: "audit-chain.verdict", agentId: null,
    timestamp: report.generatedAt, duration: Date.now() - startedAt,
    status: verdict.complete ? "ok" : "error",
    ref, refKind: report.refKind, complete: verdict.complete,
    brokenHops: verdict.brokenHops.map((h) => ({ hop: h.hop, status: h.status })),
    // snake_case KEYS per the story's Observability Contract (and the repo's
    // added-metric convention); read off the camelCase TS type by design —
    // see the comment on `ChainReport.timings`.
    pr_fetch_ms: report.timings.prFetchMs, per_hop_ms: report.timings.perHopMs,
  });
  return verdict.complete ? 0 : 1;
}

if (import.meta.main) {
  let code = 2;
  try {
    code = await run(Bun.argv.slice(2));
  } catch (err) {
    // Nothing should reach here (walkAndRender catches the walk, and the log
    // sink swallows its own errors) — but an exception that escapes must still
    // be a 2, never bun's default 1.
    writeSync(2, `!! qds-audit: ${err instanceof Error ? err.message : String(err)}\n`);
  }
  process.exit(code);
}
