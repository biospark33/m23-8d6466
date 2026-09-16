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
 * runId; this command renders them. Exit codes: 0 complete, 1 broken chain,
 * 2 bad invocation (usage / invalid ref).
 *
 * `--json` prints the ChainReport and NOTHING else on stdout; every
 * observability line (the walker's per-hop lines plus one final verdict line
 * here — the walker already logs per hop, so this CLI adds only the verdict)
 * goes to stderr. All four store paths are explicit seams: an operator (or the
 * DF5.4-C9 frozen fixture) points them at a fixture set and the walk never
 * touches the developer's own `.sandbox/`.
 *
 * INV-AUDIT-2 by construction: credential hops print `key_hash` + its 8-char
 * prefix only, and this renderer adds no field the walker did not carry.
 */

import { writeSync } from "node:fs";

import {
  AUDIT_HOPS,
  ChainWalkError,
  chainVerdict,
  walkAuditChain,
  type ChainReport,
  type HopOutcome,
} from "../src/audit/index.ts";
import { log, newRequestId, setLogSink } from "../src/swarmclaw/log.ts";
import { exitWithFailure, parseValueFlags, tokenizeArgs } from "./lib/cli-args.ts";

// Structured logs go to stderr so stdout carries only the command's output
// (the report in --json mode, the hop blocks in human mode).
if (import.meta.main) {
  setLogSink((entry) => {
    process.stderr.write(`${JSON.stringify(entry)}\n`);
  });
}

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
  ref?: string;
  json: boolean;
  runsDir?: string;
  auditDb?: string;
  ledger?: string;
  reverifyDir?: string;
}

export function parseAuditArgs(argv: readonly string[]): ParsedAuditArgs {
  const { positionals, flagTokens, bools } = tokenizeArgs(argv, {
    valueFlags: VALUE_FLAGS,
    boolFlags: BOOL_FLAGS,
  });
  const out: ParsedAuditArgs = { json: bools.has("--json"), ref: positionals[0] };
  parseValueFlags(flagTokens, {
    flags: VALUE_FLAGS,
    onValue: (flag, value) => {
      if (flag === "--runs-dir") out.runsDir = value;
      else if (flag === "--audit-db") out.auditDb = value;
      else if (flag === "--ledger") out.ledger = value;
      else out.reverifyDir = value;
    },
    help: HELP,
  });
  // Exactly one ref. Checked AFTER the flag grammar so an unknown flag is
  // reported as itself instead of masquerading as a positional.
  if (positionals.length !== 1) {
    throw new Error(
      positionals.length === 0
        ? "missing <pr-url|branch|runId>"
        : `expected exactly one ref, got ${positionals.length} (${positionals.join(", ")})`,
    );
  }
  return out;
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
      const detail = out.detail as Record<string, unknown> | undefined;
      const keyHash = typeof detail?.keyHash === "string" ? detail.keyHash : undefined;
      if (keyHash !== undefined) {
        // INV-AUDIT-2: the hash and its 8-char prefix — never key material.
        lines.push(`keyHash: ${keyHash}`, `keyHashPrefix: ${keyHash.slice(0, 8)}`);
      }
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
      break;
    case "order-violation":
      lines.push(`constraint: ${out.constraint}`, `earlier: ${out.earlier}`, `later: ${out.later}`);
      break;
    case "hop-timeout":
      lines.push(`elapsed: ${out.elapsedMs}ms`, `ceiling: ${out.ceilingMs}ms`);
      break;
    case "broken":
      lines.push(`expected: ${out.expected}`, `actual: ${out.actual}`, out.diagnostic);
      if (out.evidencePath !== undefined) lines.push(`evidence: ${out.evidencePath}`);
      break;
  }
  return lines;
}

function printHuman(report: ChainReport): void {
  for (const [runId, run] of Object.entries(report.runs)) {
    writeSync(1, `run ${runId}\n`);
    for (const hop of AUDIT_HOPS) {
      const out = (run.hops as Record<string, HopOutcome | undefined>)[hop];
      if (out === undefined) continue;
      writeSync(1, `  ${hop} [${out.status}]\n`);
      for (const line of describeHop(out)) writeSync(1, `    ${line}\n`);
    }
  }
  const verdict = chainVerdict(report);
  const broken = verdict.brokenHops.map((h) => h.hop);
  writeSync(
    1,
    verdict.complete
      ? `chain: COMPLETE (${report.ref}, ${report.refKind})\n`
      : `chain: BROKEN (${broken.length} broken hop(s): ${[...new Set(broken)].join(", ")})\n`,
  );
}

export async function run(argv: readonly string[]): Promise<void> {
  let args: ParsedAuditArgs;
  try {
    args = parseAuditArgs(argv);
  } catch (e) {
    exitWithFailure("!! usage error", 2, [USAGE, (e as Error).message]);
  }
  const ref = args.ref as string;
  const startedAt = Date.now();
  const requestId = newRequestId();

  let report: ChainReport;
  try {
    report = await walkAuditChain(ref, {
      ...(args.runsDir !== undefined ? { runsDir: args.runsDir } : {}),
      ...(args.auditDb !== undefined ? { auditDb: args.auditDb } : {}),
      ...(args.ledger !== undefined ? { ledger: args.ledger } : {}),
      ...(args.reverifyDir !== undefined ? { reverifyDir: args.reverifyDir } : {}),
    });
  } catch (e) {
    if (e instanceof ChainWalkError) {
      log({
        requestId, operation: "audit-chain.verdict", agentId: null,
        timestamp: new Date().toISOString(), duration: Date.now() - startedAt,
        status: "error", error: { code: e.code, message: e.message }, ref,
      });
      exitWithFailure(`!! ${e.code}`, 2, [e.message, `next: ${e.remediation}`]);
    }
    throw e;
  }

  const verdict = chainVerdict(report);
  if (args.json) writeSync(1, `${JSON.stringify(report)}\n`);
  else printHuman(report);
  log({
    requestId, operation: "audit-chain.verdict", agentId: null,
    timestamp: report.generatedAt, duration: Date.now() - startedAt,
    status: verdict.complete ? "ok" : "error",
    ref, refKind: report.refKind, complete: verdict.complete,
    brokenHops: verdict.brokenHops.map((h) => ({ hop: h.hop, status: h.status })),
    prFetchMs: report.timings.prFetchMs, perHopMs: report.timings.perHopMs,
  });
  process.exit(verdict.complete ? 0 : 1);
}

if (import.meta.main) {
  await run(Bun.argv.slice(2));
}
