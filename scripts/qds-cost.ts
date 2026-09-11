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
 * A ledger holding no `kind='tokens'` row gets a structured
 * `tokens-ledger-unwired` line above the numbers: with the DF2.12 token
 * bridge live (cost-ledger-bridge.ts → ingestCostEvent), that means no run
 * has delivered token rows to this ledger yet — and the totals below (and the
 * per-issue cap that reads the same SUM) count box-hours only until one does.
 * Non-fatal, and never a different exit code: it qualifies the report, it is
 * not a refusal.
 *
 * Prints the cumulative cost view for an issue, all derived from SUM (no
 * denormalized columns):
 * - Issue ref header
 * - Total spend in µ$ (raw integer) and $ (two-tier formatting)
 * - Per-role split (lead/worker/resident/tier1 + literal `box-hours` line)
 * - Per-run table (RUN | SPEND µ$ | BOX HOURS — `pending` when hasBoxHours
 *   false; TOKENS — the AC4 discriminator, re-derived per run from the same
 *   harvested evidence the teardown's bridge read:
 *   `✓` priced token rows landed | `✓ (refused n)` priced plus refusal
 *   evidence | `unpriced (n)` ingested without usable money |
 *   `unpriced (n, refused m)` | `no-token-spend` | `token-rows-refused (n)`
 *   | `tokens-not-harvested`, never `0` for unharvested spend)
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
 * dir-mode/file-mode, plus openReadOnly's wal-recovery-required and replaced-
 * ledger refusals) exit 1 with code + remediation.
 */

import { writeSync } from "node:fs";

import { CostLedger, type CostConfig, type CostView } from "../src/providers/cost-ledger.ts";
import { classifyHarvestedTokens } from "../src/providers/cost-ledger-bridge.ts";
import { resolveRunsDir } from "../src/providers/run-record.ts";
import { setLogSink } from "../src/swarmclaw/log.ts";
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

/**
 * writeSync can write short; a truncated report is worse than a slow one. The
 * same loop scripts/fleet.ts writes its report lines through — including the
 * zero-length arm, which is not a retryable short write but an fd 1/2 left
 * non-blocking (a CI runner, a wrapper), surfaced as the EAGAIN it is so the
 * guarded call sites below decide the outcome instead of spinning forever.
 */
function writeAll(fd: number, s: string): void {
  const buf = Buffer.from(s, "utf8");
  let off = 0;
  while (off < buf.length) {
    const n = writeSync(fd, buf, off, buf.length - off);
    if (n <= 0) throw Object.assign(new Error(`fd ${fd} accepted 0 of ${buf.length - off} bytes`), { code: "EAGAIN" });
    off += n;
  }
}

/**
 * A DIAGNOSTIC write is never worth changing the outcome it reports on — the
 * same posture fleet.ts's log sink takes: a throw out of the sink escapes
 * outside every envelope in `run()` and would replace a classified refusal
 * (already mapped to its exit code) with a bare crash.
 */
function writeBestEffort(fd: number, s: string): void {
  try {
    writeAll(fd, s);
  } catch {
    // Nothing left to report it to.
  }
}

function fail(out: (s: string) => void, code: string, message: string, remediation?: string): void {
  out(`!! ${code}: ${message}\n`);
  if (remediation !== undefined) out(`next: ${remediation}\n`);
}

/**
 * A FAILURE report is best-effort (the same posture run-lock.ts's writeStderr
 * and sandbox-teardown.ts's reportFailure take): `out` is writeSync(1, …), so
 * an EPIPE from a closed pipe must not replace the classified error or skip
 * the mapped exit code.
 */
function reportFailure(out: (s: string) => void, code: string, message: string, remediation?: string): void {
  try {
    fail(out, code, message, remediation);
  } catch {
    // stdout is gone; the exit code still says what happened.
  }
}

/**
 * The exit taxonomy for the codes `CostLedger.openReadOnly` refuses with.
 * The CLI-local guard this mapping replaced — the no-create probe, the probe
 * fd held across the open, and the post-open inode compare that closes the C5
 * replace race — now lives inside openReadOnly (see `openReadOnlyHandle`
 * there); only the TRANSLATION to this CLI's operator surface remains here:
 * `ledger-absent` and `ledger-identity-changed` map onto the long-standing
 * `ledger-missing` / `ledger-replaced` wordings below (byte-identical to what
 * the CLI-local probe used to refuse with, and what tests pin), as does
 * `ledger-unopenable` → `ledger-unreadable` (the probe's non-ENOENT refusal,
 * whose remediation deliberately does NOT suggest deleting the ledger — it may
 * be live), while `ledger-wal-recovery-required` renders the error's own
 * words. Exported so the mapping is testable in-process: staging a replace
 * inside a live child's probe→attach window is the C5 race itself, which no
 * black-box test can provoke deterministically.
 */
export function reportLedgerOpenFailure(out: (s: string) => void, e: unknown, ledgerPath: string): number {
  // D8 (round 3): a nullish/non-object rejection must reach the classified
  // surface too — `err.code` on `null` used to throw an unclassified TypeError
  // past this whole mapping.
  const err = (e ?? {}) as { code?: string; message?: string; remediation?: string };
  switch (err.code) {
    case "ledger-absent":
      reportFailure(
        out,
        "ledger-missing",
        `no cost ledger at ${ledgerPath} — refusing to report zero spend from a file that does not exist`,
        "dispatch a run first (the budget gate creates the ledger), or point --dir / QDS_RUNS_DIR at the records directory whose runs you are asking about",
      );
      return 1;
    case "ledger-identity-changed":
      reportFailure(
        out,
        "ledger-replaced",
        `the cost ledger at ${ledgerPath} was removed or replaced while this invocation opened it — refusing to report spend from a file that was not there when the read began`,
        "re-run once any concurrent dispatch or teardown has finished writing this ledger",
      );
      return 1;
    case "ledger-unopenable":
      reportFailure(
        out,
        "ledger-unreadable",
        `cannot read the cost ledger at ${ledgerPath} (${err.message ?? String(e)})`,
        // D8 (round 3): openReadOnly's own remediation LEADS with the WAL note
        // when an uncheckpointed -wal sits beside the ledger — the WAL may
        // hold the only copy of committed spend, so substituting the generic
        // "fix the permissions" text invited deleting it. Pass the thrown
        // remediation through; the generic text is only the fallback.
        typeof err.remediation === "string" && err.remediation !== ""
          ? err.remediation
          : "fix the permissions on the ledger file and its directory, then re-run",
      );
      return 1;
    default:
      reportFailure(
        out,
        err.code ?? "ledger-unopenable",
        err.message ?? String(e),
        // R4-41: an empty remediation forwarded verbatim rendered a bare
        // `next:` line with no advice after it — automation keys on the line,
        // so it must carry words or not exist. Same guard as the sibling
        // ledger-unreadable arm above.
        typeof err.remediation === "string" && err.remediation !== "" ? err.remediation : undefined,
      );
      return 1;
  }
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
 * The per-run TOKENS cell (DF2.12 AC4). The discriminator is the HARVESTED
 * EVIDENCE, re-derived here from the same file the teardown's bridge read —
 * `<runsDir>/<runId>-artifacts/<runId>.engine.log` — through the same
 * classifier the bridge uses, so the two surfaces agree by construction:
 * absent/unreadable → `tokens-not-harvested` (never `0`); zero token-evidence
 * lines → `no-token-spend`; lines present whose rows all landed UNPRICED
 * (unusable money, sub-µ$) → `unpriced (n)` — those rows were ingested, and
 * calling them refused would misreport honest evidence; lines present with NO
 * token row at all in the ledger → `token-rows-refused (n)` where n counts
 * REFUSAL-EVIDENCE lines only (the classifier's refused markers and truncated
 * lines — never parseable attribution lines).
 *
 * Refusal evidence is never hidden by good news (review round 6): a run with
 * priced rows AND refused evidence renders `✓ (refused n)`; an unpriced run
 * with refused evidence renders `unpriced (n, refused m)`. The bare arms
 * (`✓`, `unpriced (n)`) are reserved for logs whose refused count is zero.
 *
 * The classification is guarded per run: an unexpected classifier error is
 * the fail-closed `tokens-not-harvested (<reason>)` cell — the report and its
 * exit code survive. The LEDGER read is deliberately OUTSIDE the guard: a
 * ledger failure is the report's classified error, not evidence that a run's
 * tokens went unharvested.
 *
 * Evidence-vs-ledger drift, named rather than fixed (AC4 pins
 * evidence-first): a log DELETED after a successful ingest renders
 * `tokens-not-harvested` beside a priced SPEND row, and a log whose lines
 * were lost before ingest renders `no-token-spend` beside one. The cell
 * reports the evidence file; the money columns report the ledger.
 */
function renderTokenCell(ledger: CostLedger, runsDir: string, runId: string): string {
  let state: ReturnType<typeof classifyHarvestedTokens>;
  try {
    state = classifyHarvestedTokens(runsDir, runId);
  } catch (e) {
    return `tokens-not-harvested (${(e as Error)?.message ?? String(e)})`;
  }
  if (state.state === "tokens-not-harvested") return "tokens-not-harvested";
  if (state.state === "no-token-spend") return "no-token-spend";
  const view = ledger.readRunCost(runId);
  const pricedRoles = Object.keys(view?.perRole ?? {}).filter((k) => k !== "box-hours");
  const refused = state.refusedLines;
  if (pricedRoles.length > 0) return refused > 0 ? `✓ (refused ${refused})` : "✓";
  // No priced token bucket. Token rows still landed? They were ingested
  // UNPRICED — evidence, not a refusal. (`unpricedRows` counts token-kind
  // rows only: the box-hours insert writes `unpriced = 0` unconditionally.)
  const unpriced = view?.unpricedRows ?? 0;
  if (unpriced > 0) return refused > 0 ? `unpriced (${unpriced}, refused ${refused})` : `unpriced (${unpriced})`;
  return `token-rows-refused (${refused})`;
}

/**
 * Print the cost view to stdout.
 */
function printView(
  out: (s: string) => void,
  issueRef: string,
  view: CostView,
  runs: Array<{runId: string; totalMicroUsd: number; hasBoxHours: boolean; tokens: string}>,
): void {
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
    out(`  ${pad("RUN", 30)} ${pad("SPEND µ$", 15)} ${pad("BOX HOURS", 12)} ${pad("TOKENS", 24)}\n`);
    out(`  ${pad("".padEnd(30, "-"), 30)} ${pad("".padEnd(15, "-"), 15)} ${pad("".padEnd(12, "-"), 12)} ${pad("".padEnd(24, "-"), 24)}\n`);
    for (const run of runs) {
      const boxHours = run.hasBoxHours ? "✓" : "pending";
      out(`  ${pad(run.runId, 30)} ${pad(formatNumber(run.totalMicroUsd), 15)} ${pad(boxHours, 12)} ${pad(run.tokens, 24)}\n`);
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
    // A repeated `--dir` used to silently last-win: the second value overrode
    // the first, and against a typo'd or wrong directory the CLI then reported
    // from (or refused ledger-missing for) a records dir the operator never
    // believed they typed. Every other typo class here refuses loudly; this
    // one now does too, with the same "given more than once" wording
    // scripts/fleet.ts refuses duplicate flags by. A Set is enough — both
    // occurrences carry the same name.
    const seenValueFlags = new Set<string>();
    parseValueFlags(flagTokens, {
      flags: VALUE_FLAGS,
      onValue: (flag, value) => {
        if (seenValueFlags.has(flag)) {
          // The `!!`-envelope the rest of this CLI refuses with (see
          // `reportFailure`): the bare usage message kept the exit code but
          // dropped the code prefix and the remediation line automation keys
          // on. Tests pin the message SUBSTRING, which the envelope preserves.
          throw new Error(`!! cost-usage-invalid: ${flag} given more than once\nnext: pass a single --dir value\n${HELP.join("\n")}`);
        }
        seenValueFlags.add(flag);
        dir = value;
      },
      help: HELP,
    });
    if (positionals.length > 1) {
      throw new Error(`!! cost-usage-invalid: unexpected argument: ${positionals[positionals.length - 1]}\nnext: pass one issue reference (owner/repo#N) — flags only, no extra positionals\n${HELP.join("\n")}`);
    }
    // The shared grammar refuses an EMPTY `--dir`/`--dir=` value, but a
    // WHITESPACE-ONLY one passed straight through and resolved the ledger
    // against a literal-space path (`./ /cost-ledger.db`) — a confident
    // ledger-miss for a typo'd space. Same refusal as a missing value.
    if (dir !== undefined && dir.trim() === "") {
      throw new Error(`!! cost-usage-invalid: --dir requires a non-empty value\nnext: pass a --dir path that is not only whitespace\n${HELP.join("\n")}`);
    }
    issueRef = parseIssueRef(positionals[0]);
  } catch (e) {
    out((e as Error).message);
    return 2;
  }

  // The store's own resolution chain, through the EXPORTED helper rather than a
  // restatement of it: the restated chain here was the split-brain its own
  // comment warned about — resolveRunsDir moving (or gaining a tier) left this
  // CLI resolving a different records directory than the stores that write
  // into it. The helper is a pure string resolution, not the constructor: no
  // mkdir, no chmod, so the REPORTING CLI still never materializes the
  // directory it is asked about (the fail-open INV-COST-6 forbids).
  const storeDir = resolveRunsDir(dir);

  let config: CostConfig;
  let ledgerPath: string;
  try {
    // Both halves from the same helper the money-MOVING CLIs use, so the file
    // reported on is the file written to (see the header).
    ({ config, path: ledgerPath } = costLedgerOpts(storeDir));
  } catch (e) {
    const err = e as { code?: string; message?: string; remediation?: string };
    reportFailure(out, err.code ?? "cost-config-error", err.message ?? String(e), err.remediation);
    return 1;
  }

  // INV-COST-6 for the reporting side: an absent ledger refuses instead of
  // materializing an empty one — a typo'd $QDS_COST_LEDGER_FILE or a wrong
  // --dir must not read as "nothing spent".
  //
  // The whole guard — no-create probe, probe fd held across the open, and the
  // post-open inode compare that closes the C5 race (a ledger removed inside
  // the open window must not come back as a fresh empty db reading a
  // confident ZERO SPEND) — moved into CostLedger.openReadOnly (DF2.11), and
  // openReadOnly performs no disk side effect of its own (INV-COST-7), so the
  // reporting CLI still never materializes the ledger it is asked about. This
  // site keeps only the refusal translation, in `reportLedgerOpenFailure`
  // above.
  let ledger: CostLedger;
  try {
    ledger = CostLedger.openReadOnly({ config, path: ledgerPath });
  } catch (e) {
    return reportLedgerOpenFailure(out, e, ledgerPath);
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
    // BEFORE the numbers, because it qualifies them: a ledger with no
    // `kind='tokens'` row has received nothing from the DF2.12 token bridge
    // yet, so the totals below price box hours only and the per-issue cap is
    // enforcing against that same partial figure. Reading the totals without
    // this line is how an operator concludes an issue is cheap. Ledger-wide
    // and non-fatal: it never changes the exit code.
    ledger.emitTokenBridgeState();
    const view = ledger.readIssueCost(issueRef.repoSlug, issueRef.issueId);
    const runs = ledger.readIssueRuns(issueRef.repoSlug, issueRef.issueId).map((run) => ({
      ...run,
      tokens: renderTokenCell(ledger, storeDir, run.runId),
    }));

    printView(out, `${issueRef.repoSlug}#${issueRef.issueId}`, view, runs);
    code = 0;
  } catch (e) {
    const err = e as { code?: string; message?: string; remediation?: string };
    reportFailure(out, err.code ?? "ledger-error", err.message ?? String(e), err.remediation);
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
        // writeAll, not process.stderr.write — run() returns straight into
        // process.exit below, and a piped/redirected stderr tears down before
        // an async write lands. This warning is the only record that the
        // ledger handle failed to release, so it must not be the line lost —
        // but a stderr that refuses the bytes must not replace the classified
        // error either, hence best-effort (fleet.ts's diagnostic posture).
        writeBestEffort(2, `warning: ledger close failed after error: ${(closeErr as Error).message}\n`);
      } else {
        const cerr = closeErr as { code?: string; message?: string; remediation?: string };
        reportFailure(out, cerr.code ?? "ledger-close-failed", cerr.message ?? String(closeErr), cerr.remediation);
        code = 1;
      }
    }
  }
  return code;
}

/**
 * The report's numbers are computed before the first line is printed, so a
 * refused stdout line is a LOST TABLE, not a failed computation. EAGAIN (fd 1
 * left non-blocking by a wrapper or CI runner) must not discard the report
 * for a retryable exit 1 the retry cannot fix: degrade — name the loss on
 * stderr, let the verdict path run. Any other write failure (ENOSPC, EBADF, a
 * closed pipe) still throws: a partially printed report must not read as
 * complete, and `run`'s catch classifies it.
 */
function writeReport(out: (s: string) => void): (s: string) => void {
  return (s: string): void => {
    try {
      out(s);
    } catch (e) {
      const errno = (e as NodeJS.ErrnoException | null)?.code;
      if (errno !== "EAGAIN" && errno !== "EWOULDBLOCK") throw e;
      writeBestEffort(
        2,
        `qds-cost: stdout would not take part of the report (${errno}) — what it printed is INCOMPLETE\n`,
      );
    }
  };
}

if (import.meta.main) {
  // D5 (round 3): the ledger's structured frames (the `tokens-ledger-unwired`
  // qualification) emit through the swarmclaw DEFAULT sink,
  // `process.stdout.write` — asynchronous on a pipe or redirect, and
  // `process.exit` below tears the stream down before a pending write lands,
  // so the one line the feature exists to print was exactly the line a
  // `qds-cost … > report.txt` could lose. This sink keeps the frame on stdout
  // (where its contract and its tests read it) but writes it with the
  // same writeSync discipline as every report line — and degrades like
  // fleet.ts's sink: the ledger emits the frame from inside its own reporting
  // path, so a raising sink must not escape past the mapped exit code
  // (R4-14: a bare `writeSync` also wrote SHORT, truncating the JSON frame,
  // and an fd 1 left non-blocking killed the CLI outside every envelope).
  // In-process callers (tests) install no sink and are unaffected.
  setLogSink((entry) => writeBestEffort(1, `${JSON.stringify(entry)}\n`));
  try {
    process.exit(run(process.argv.slice(2), writeReport((s) => writeAll(1, s))));
  } catch (e) {
    // A nullish throw printed `undefined` and told the operator nothing —
    // same throw-safe coercion fleet.ts's own top-level catch uses.
    writeBestEffort(2, `${(e as Error)?.message ?? String(e)}\n`);
    process.exit(1);
  }
}
