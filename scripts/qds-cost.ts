#!/usr/bin/env bun
/**
 * CLI: qds-cost — operator-facing view of DF2.8 cost ledger (AC2, AC5).
 *
 * Usage:
 *   qds-cost <owner/repo>#<N> [--dir <path>]
 *
 * The ledger and the cost config are resolved from the RECORDS directory
 * through `scripts/lib/cost-ledger-opts.ts` — the same helper `scripts/fleet.ts`
 * reserves budget through and `scripts/sandbox-teardown.ts` settles box hours
 * through. Reading `QDS_COST_LEDGER_FILE ?? DEFAULT_COST_LEDGER_FILE` directly,
 * as this CLI did, made the REPORTING side the one CLI that did not honour
 * `--dir` / `$QDS_RUNS_DIR`: with `QDS_RUNS_DIR=/srv/runs` the spend went to
 * /srv/runs/cost-ledger.db while `qds-cost owner/repo#12` opened the
 * cwd-relative default — `ledger-missing` at best, and a confident ZERO SPEND
 * for an issue that has burned budget whenever a stale .sandbox/cost-ledger.db
 * happened to exist.
 *
 * Prints the cumulative cost view for an issue, all derived from SUM (no
 * denormalized columns):
 * - Issue ref header
 * - Total spend in µ$ (raw integer) and $ (two-tier formatting)
 * - Per-role split (lead/worker/resident/tier1 + literal `box-hours` line)
 * - Per-run table (RUN | SPEND µ$ | BOX HOURS — `pending` when hasBoxHours false)
 * - Token totals (inputTokens/outputTokens) with thousands separators
 * - Cache totals (cacheReadTokens/cacheWriteTokens) with thousands separators
 * - Unpriced row count
 *
 * Zero-row issue: prints 0 µ$, empty split, "no ledger rows for this issue",
 * exit 0 (not an error, AC5) — for an EXISTING ledger file; an absent one
 * refuses with `ledger-missing` (INV-COST-6: a reporting CLI must not invent
 * an empty ledger and read it as zero spend).
 *
 * Bare issue numbers, `#42`, `demo#42` (no owner), or empty argv are rejected
 * with `cost-ref-invalid` and exit 2.
 *
 * Config errors (unreadable/invalid) and ledger errors (missing/unopenable/
 * dir-mode/file-mode) exit 1 with code + remediation.
 */

import { existsSync, writeSync } from "node:fs";

import { CostLedger, type CostConfig, type CostView } from "../src/providers/cost-ledger.ts";
import { DEFAULT_RUNS_DIR } from "../src/providers/run-record.ts";
import { parseValueFlags, tokenizeArgs } from "./lib/cli-args.ts";
import { costLedgerOpts } from "./lib/cost-ledger-opts.ts";

const ISSUE_REF_RE = /^[\w.-]+\/[\w.-]+#\d+$/;

const VALUE_FLAGS = ["--dir"] as const;

const HELP = [
  "Usage: qds-cost <owner/repo>#<N> [--dir <path>]",
  "",
  "  <owner/repo>#<N>        issue reference (e.g. qds/demo#42)",
  "  --dir <path>            records directory (default $QDS_RUNS_DIR)",
  "",
  "Env: QDS_RUNS_DIR          records directory (default .sandbox/runs)",
  "     QDS_COST_LEDGER_FILE  overrides the ledger path derived from it",
  "     QDS_COST_CONFIG_FILE  overrides the cost config path derived from it",
  "",
];

function fail(out: (s: string) => void, code: string, message: string, remediation?: string): void {
  out(`!! ${code}: ${message}\n`);
  if (remediation !== undefined) out(`next: ${remediation}\n`);
}

/**
 * Validate a micro-dollar total from the ledger SUM. Throws if the total
 * is corrupt (non-finite, negative, or not a safe integer) — this must never
 * print "$NaN" or negative money.
 */
function assertValidMicroTotal(microUsd: number, context: string): void {
  if (!Number.isFinite(microUsd)) {
    throw new Error(`!! cost-view-invalid: ${context} total is not finite (${microUsd}) — ledger corruption detected\nnext: re-create the ledger from source events after diagnosing the corruption`);
  }
  if (microUsd < 0) {
    throw new Error(`!! cost-view-invalid: ${context} total is negative (${microUsd} µ$) — ledger corruption detected\nnext: re-create the ledger from source events after diagnosing the corruption`);
  }
  if (!Number.isSafeInteger(microUsd)) {
    throw new Error(`!! cost-view-invalid: ${context} total is not a safe integer (${microUsd}) — ledger corruption detected\nnext: re-create the ledger from source events after diagnosing the corruption`);
  }
}

/**
 * Two-tier money formatting (ponytail: lifted from inkwell's tracer.py).
 * - >= $1.00 → 2 decimal places
 * - < $1.00 → 4 decimal places (sub-cent precision)
 */
function formatCost(microUsd: number): string {
  const usd = microUsd / 1_000_000;
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  return `$${usd.toFixed(4)}`;
}

/** Thousands separator for token counts */
function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
}

/** Pad string to fixed width (ponytail: fixed-width table renderer) */
function pad(s: string, width: number): string {
  return s.padEnd(width);
}

/**
 * Print the cost view to stdout.
 */
function printView(out: (s: string) => void, issueRef: string, view: CostView, runs: Array<{runId: string; totalMicroUsd: number; hasBoxHours: boolean}>): void {
  assertValidMicroTotal(view.totalMicroUsd, `issue ${issueRef}`);
  out(`${issueRef}\n\n`);

  // Total line: µ$ + $
  out(`TOTAL: ${formatNumber(view.totalMicroUsd)} µ$  ${formatCost(view.totalMicroUsd)}\n\n`);

  // Per-role split
  if (Object.keys(view.perRole).length > 0) {
    out("PER ROLE:\n");
    for (const [role, microUsd] of Object.entries(view.perRole)) {
      assertValidMicroTotal(microUsd, `role ${role} in issue ${issueRef}`);
      const label = role === "box-hours" ? "box-hours (unattributed)" : role;
      out(`  ${pad(label, 24)} ${pad(formatNumber(microUsd), 15)} µ$  ${formatCost(microUsd)}\n`);
    }
    out("\n");
  }

  // Per-run table
  if (runs.length > 0) {
    out("PER RUN:\n");
    // Header
    out(`  ${pad("RUN", 30)} ${pad("SPEND µ$", 15)} ${pad("BOX HOURS", 12)}\n`);
    out(`  ${pad("".padEnd(30, "-"), 30)} ${pad("".padEnd(15, "-"), 15)} ${pad("".padEnd(12, "-"), 12)}\n`);
    for (const run of runs) {
      const boxHours = run.hasBoxHours ? "✓" : "pending";
      out(`  ${pad(run.runId, 30)} ${pad(formatNumber(run.totalMicroUsd), 15)} ${pad(boxHours, 12)}\n`);
    }
    out("\n");
  }

  // Token totals
  if (view.hasEvents) {
    out(`TOKENS:  input ${formatNumber(view.tokenTotals.inputTokens)}  output ${formatNumber(view.tokenTotals.outputTokens)}\n`);
  }

  // Cache totals
  if (view.hasEvents) {
    out(`CACHE:   read ${formatNumber(view.cacheTotals.cacheReadTokens)}  write ${formatNumber(view.cacheTotals.cacheWriteTokens)}\n`);
  }

  // Unpriced count (always shown)
  out(`unpriced rows: ${view.unpricedRows}\n`);

  // Zero-row case (AC5)
  if (!view.hasEvents) {
    out("no ledger rows for this issue\n");
  }
}

/**
 * Parse and validate the issue reference.
 */
function parseIssueRef(arg: string | undefined): { repoSlug: string; issueId: string } {
  if (arg === undefined) {
    throw new Error(`!! cost-ref-invalid: missing issue reference\nnext: provide an issue reference matching owner/repo#N\n${HELP.join("\n")}`);
  }
  if (!ISSUE_REF_RE.test(arg)) {
    throw new Error(`!! cost-ref-invalid: invalid issue reference ${JSON.stringify(arg)} (must match owner/repo#N)\nnext: provide an issue reference matching owner/repo#N\n${HELP.join("\n")}`);
  }
  const parts = arg.split("#");
  if (parts.length !== 2) {
    throw new Error(`!! cost-ref-invalid: invalid issue reference ${JSON.stringify(arg)} (must match owner/repo#N, got ${parts.length - 1} '#' separators)\nnext: provide an issue reference matching owner/repo#N\n${HELP.join("\n")}`);
  }
  const [repoSlug, issueId] = parts;
  if (repoSlug === undefined || issueId === undefined || !/^\d+$/.test(issueId)) {
    throw new Error(`!! cost-ref-invalid: invalid issue reference ${JSON.stringify(arg)} (must match owner/repo#N)\nnext: provide an issue reference matching owner/repo#N\n${HELP.join("\n")}`);
  }
  return { repoSlug, issueId };
}

/**
 * Main run function — pure, no top-level side effects.
 */
export function run(argv: readonly string[], out: (s: string) => void): number {
  let issueRef: { repoSlug: string; issueId: string };
  let dir: string | undefined;
  try {
    // The shared grammar, so `--dir` means here exactly what it means on
    // `fleet` and `sandbox-teardown` — including `--dir=<path>` and the missing-
    // value refusal. The issue ref stays the sole positional.
    const { positionals, flagTokens } = tokenizeArgs(argv, { valueFlags: VALUE_FLAGS });
    parseValueFlags(flagTokens, {
      flags: VALUE_FLAGS,
      onValue: (_flag, value) => {
        dir = value;
      },
      help: HELP,
    });
    if (positionals.length > 1) {
      throw new Error(
        `unexpected argument: ${positionals[positionals.length - 1]}\n${HELP.join("\n")}`,
      );
    }
    issueRef = parseIssueRef(positionals[0]);
  } catch (e) {
    out((e as Error).message);
    return 2;
  }

  // The store's own three-tier chain, restated rather than taken from a
  // `RunRecordStore`: that constructor mkdirs the records directory and chmods
  // it 0700, and a REPORTING CLI that materializes the directory it is asked
  // about is the same fail-open INV-COST-6 forbids one level up.
  const storeDir = dir ?? process.env.QDS_RUNS_DIR ?? DEFAULT_RUNS_DIR;

  let config: CostConfig;
  let ledgerPath: string;
  try {
    // Both halves from the same helper the money-MOVING CLIs use, so the file
    // reported on is the file written to (see the header).
    ({ config, path: ledgerPath } = costLedgerOpts(storeDir));
  } catch (e) {
    const err = e as { code?: string; message?: string; remediation?: string };
    fail(out, err.code ?? "cost-config-error", err.message ?? String(e), err.remediation);
    return 1;
  }

  // INV-COST-6 for the reporting side: an absent ledger refuses instead of
  // materializing an empty one — a typo'd $QDS_COST_LEDGER_FILE or a wrong
  // --dir must not read as "nothing spent". C5 notes: existsSync()-then-open
  // race exists; CostLedger creates missing files, so we must pre-check for the
  // "refuse absent" behavior.
  if (!existsSync(ledgerPath)) {
    fail(
      out,
      "ledger-missing",
      `no cost ledger at ${ledgerPath} — refusing to report zero spend from a file that does not exist`,
      "dispatch a run first (the budget gate creates the ledger), or point --dir / QDS_RUNS_DIR at the records directory whose runs you are asking about",
    );
    return 1;
  }
  let ledger: CostLedger;
  try {
    ledger = new CostLedger({ config, path: ledgerPath });
  } catch (e) {
    const err = e as { code?: string; message?: string; remediation?: string };
    fail(out, err.code ?? "ledger-unopenable", err.message ?? String(e), err.remediation);
    return 1;
  }

  // Assigned on every path, then possibly downgraded by the finally — the same
  // shape scripts/fleet.ts and scripts/sandbox-teardown.ts use. `return 1`
  // inside the finally overwrote the try/catch's own control flow, so a close
  // failure could discard the real outcome; and `return 0` inside the try
  // committed the exit code before the cleanup could say anything. Seeded to
  // failure because the finally READS it: only a completed print sets 0, so a
  // throw the catch cannot itself survive never reads as success.
  let code = 1;
  try {
    const view = ledger.readIssueCost(issueRef.repoSlug, issueRef.issueId);
    const runs = ledger.readIssueRuns(issueRef.repoSlug, issueRef.issueId);

    printView(out, `${issueRef.repoSlug}#${issueRef.issueId}`, view, runs);
    code = 0;
  } catch (e) {
    const err = e as { code?: string; message?: string; remediation?: string };
    fail(out, err.code ?? "ledger-error", err.message ?? String(e), err.remediation);
    code = 1;
  } finally {
    try {
      ledger.close();
    } catch (closeErr) {
      // The shared cleanup-failure policy (stated in full at scripts/fleet.ts's
      // finally, and matched by scripts/sandbox-teardown.ts): if close fails
      // while an original error is in flight, the original takes precedence
      // (the close failure is a stderr warning); if close fails on the success
      // path, the close failure IS the error.
      if (code !== 0) {
        process.stderr.write(`warning: ledger close failed after error: ${(closeErr as Error).message}\n`);
      } else {
        const cerr = closeErr as { code?: string; message?: string; remediation?: string };
        fail(out, cerr.code ?? "ledger-close-failed", cerr.message ?? String(closeErr), cerr.remediation);
        code = 1;
      }
    }
  }
  return code;
}

if (import.meta.main) {
  try {
    process.exit(run(process.argv.slice(2), (s) => writeSync(1, s)));
  } catch (e) {
    writeSync(2, `${(e as Error).message}\n`);
    process.exit(1);
  }
}
