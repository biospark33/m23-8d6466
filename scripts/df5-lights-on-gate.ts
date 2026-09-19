/**
 * DF5.4 — the lights-on exit gate (story DF5.4; §8 step 5 of the v5
 * architecture design).
 *
 * Clause map (NET-NEW per DD-8, re-derived from §8 step 5 — "channel → fleet
 * → team → gates → bundle → host-side re-verify → PR with audit chain and
 * cost ledger"):
 *
 *   P1  preflight  — the run of record exists, is readable, names a runId            [DF5.4]
 *   C1  channel    — requestId + extensions.budget admission evidence                [DF3.1/DF2.8]
 *   C2  fleet      — created, filled at a pinned SHA, setup gate green (negated
 *                    extensions.gate + closedAt + commitSha), approved, spent        [DF3.1/DF2.2/DF2.5]
 *   C3  team       — harvested NDJSON envelope present, parses, >=1 line, 0 malformed [DF1.6]
 *   C4  gates      — harvested gate_results rows: >=1, every passed a literal 0/1     [DF1.2/DF1.4]
 *   C5  bundle     — refs/sandbox/<runId> resolves in the --git-dir bare repo         [DF2.5]
 *   C6  re-verify  — bound report green, completedAt strictly before pr.createdAt     [DF5.1]
 *   C7  approval   — terminal approved, bound < decidedAt < pr.createdAt, strict      [DF3.4]
 *   C8  PR         — frozen pr-body.txt shape: runId, Issue: line, cost line          [DF5.2]
 *   C9  audit      — qds-audit walk by runId: ten hops, zero bad, links on 4/5/6      [DF5.3]
 *   C10 cost       — openReadOnly readRunCost: hasEvents, non-zero µ$; spend <= cap   [DF2.8/DF2.11]
 *   V1  memory     — VOID (DD-4): OQ-4 unresolved, step-6 outside the v5 horizon     [DF5.4 step 6]
 *
 * Every clause asserts against a FROZEN run of record through the path seams
 * (--runs-dir, --git-dir, --audit-db, --ledger, --reverify-dir, --pr-body):
 * a gate must be safe to re-run, and a live path costs money, mutates, or
 * depends on a third-party artifact outliving the fixture. The chassis
 * (src/gate/gate-runner.ts) is reused unchanged — this driver adds clauses,
 * never chassis behavior.
 *
 * Output, in order: the versioned JSON report at --report, written FIRST and
 * ATOMICALLY (same-dir tmp + renameSync) after GateReportSchema.parse proves
 * its shape; then one structured log line per assertion plus a summary on
 * stderr; then the per-clause verdict table on stdout terminating
 * `DF_GATE: PASS|FAIL`. Exit 0 = PASS, 1 = FAIL, 2 = fatal — and exit 2 is
 * bidirectional: no verdict line ever precedes it (the report is on disk
 * before any PASS reaches stderr), and it always leaves nothing at --report
 * (the tmp+rename write cannot strand truncated JSON there).
 */
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { exitWithFailure, parseValueFlags, tokenizeArgs } from "./lib/cli-args.ts";
import {
  GateAssertionSchema,
  GateReportSchema,
  runGate,
  type GateAssertion,
  type GateReport,
} from "../src/gate/gate-runner.ts";
import { resolveRunsDir } from "../src/providers/run-record.ts";
import { df5BoundaryAssertions } from "../src/gate/assertions/df5-boundary.ts";
import { df5AccountingAssertions } from "../src/gate/assertions/df5-accounting.ts";
import { df5ExecutionAssertions } from "../src/gate/assertions/df5-execution.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");
const GATE_NAME = "df5-lights-on";
const GATE_VERSION = "1.0.0";
const CLAUSE_MAP_VERSION = "1.0.0";
const DEFAULT_REPORT = join(REPO_ROOT, "_bmad-output", "evidence", "df5-4", "df5-lights-on-gate-report.json");

/** The surviving 60 s-per-assertion / 5-min-total discipline (p1-17:38), not the chassis defaults. */
const RUN_OPTIONS = { assertionTimeoutMs: 60_000, totalTimeoutMs: 300_000 } as const;

/** Run id is interpolated into `<runsDir>/${runId}.json`, `refs/sandbox/${runId}` and the
 *  DF5.3 walker argv — the capture-tool charset, plus shape rules the charset
 *  alone lets through and that break those interpolations: `.`/`..` and any
 *  `..` substring escape a path segment, a leading `.` hides the record, a
 *  leading `-` reaches the walker argv as a flag, a trailing `.lock` collides
 *  with lock-file naming. Length is capped at RUN_ID_MAX_CHARS so a long id
 *  fails validation, not NAME_MAX at first file touch. */
const RUN_ID_RE = /^[A-Za-z0-9._-]+$/;
const RUN_ID_MAX_CHARS = 128;

const VALUE_FLAGS = [
  "--run-id",
  "--report",
  "--runs-dir",
  "--git-dir",
  "--audit-db",
  "--ledger",
  "--reverify-dir",
  "--pr-body",
] as const;

const HELP = [
  "Usage: bun scripts/df5-lights-on-gate.ts --run-id <id> [flags]",
  "",
  "  --run-id <id>         the run of record to assert against (required)",
  "  --report <path>       report destination (default _bmad-output/evidence/df5-4/…report.json)",
  "  --runs-dir <dir>      run records + artifacts (default $QDS_RUNS_DIR or .sandbox/runs)",
  "  --git-dir <dir>       bare repo carrying refs/sandbox/<runId> (default <runs-dir>/refs.git)",
  "  --audit-db <path>     audit-links store (default <runs-dir>/audit.db)",
  "  --ledger <path>       cost ledger (default <runs-dir>/cost-ledger.db)",
  "  --reverify-dir <dir>  reverify records (default <runs-dir>/reverify)",
  "  --pr-body <path>      frozen PR body (default <runs-dir>/pr-body.txt)",
  "",
  "  The gate is read-only except for the report file and the first-observation",
  "  digest rows the DF5.3 walker inserts into the audit store itself (INV-GATE-1).",
  "  Against a frozen fixture, point every seam inside the fixture copy.",
  "",
  "  Frozen-fixture layout (story deviation 6): the fixture stores the reverify",
  "  record as <runId>.reverify.jsonl. A harness must rename it to",
  "  reverify/<runId>.jsonl under the scratch copy — --reverify-dir reads only",
  "  the renamed location.",
] as const;

/** Drift notes recorded per the story's deviation clause — never silent reinterpretation:
 *  story cites kebab-case drift (gate-runner.ts, fleet/dispatch.ts, phase-engine/trace/schema.ts),
 *  GateAssertionResult.duration_ms (not `duration`), harvest WAL handling at harvest.ts:643-676,
 *  CostLedger.openReadOnly carries a 4th refusal code `ledger-unopenable` (C10 skips name it). */

interface ParsedArgs {
  runId: string;
  report: string;
  runsDir: string;
  gitDir: string;
  auditDb: string;
  ledger: string;
  reverifyDir: string;
  prBody: string;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const { flagTokens } = tokenizeArgs(argv, { valueFlags: VALUE_FLAGS, rejectStraySingleDash: true });
  const seen = new Set<string>();
  const a: Record<string, string> = {};
  parseValueFlags(flagTokens, {
    flags: VALUE_FLAGS,
    onValue: (flag, value) => {
      if (seen.has(flag)) throw new Error(`${flag} given more than once`);
      seen.add(flag);
      if (value.startsWith("~")) throw new Error(`${flag}: ~ is not expanded here — pass an absolute path`);
      a[flag] = value;
    },
    help: HELP,
  });
  if (!a["--run-id"]) throw new Error("missing --run-id <id> — the gate asserts one run of record");
  const runId = a["--run-id"];
  if (runId.length > RUN_ID_MAX_CHARS) {
    throw new Error(
      `--run-id must be at most ${RUN_ID_MAX_CHARS} characters (got ${runId.length}) — longer ids overflow NAME_MAX and cannot form a run-record path`,
    );
  }
  // The charset alone lets path-hostile shapes through; name every rejected
  // shape in the message so the operator sees why, not just the regex.
  const shapeRejections: string[] = [];
  if (runId.includes("..")) shapeRejections.push("a '..' substring");
  if (runId.startsWith(".")) shapeRejections.push("a leading '.'");
  if (runId.startsWith("-")) shapeRejections.push("a leading '-'");
  if (runId.endsWith(".lock")) shapeRejections.push("a trailing '.lock'");
  if (!RUN_ID_RE.test(runId) || shapeRejections.length > 0) {
    throw new Error(
      `--run-id must match ${RUN_ID_RE.source} excluding . and .., a '..' substring, a leading '.', a leading '-', and a trailing '.lock' (got ${JSON.stringify(runId)})`,
    );
  }
  const runsDir = resolve(a["--runs-dir"] ?? resolveRunsDir());
  return {
    runId: a["--run-id"],
    report: resolve(a["--report"] ?? DEFAULT_REPORT),
    runsDir,
    gitDir: resolve(a["--git-dir"] ?? join(runsDir, "refs.git")),
    auditDb: resolve(a["--audit-db"] ?? join(runsDir, "audit.db")),
    ledger: resolve(a["--ledger"] ?? join(runsDir, "cost-ledger.db")),
    reverifyDir: resolve(a["--reverify-dir"] ?? join(runsDir, "reverify")),
    prBody: resolve(a["--pr-body"] ?? join(runsDir, "pr-body.txt")),
  };
}

export interface Df5GateDeps {
  runId: string;
  runsDir: string;
  gitDir: string;
  auditDb: string;
  ledger: string;
  reverifyDir: string;
  prBody: string;
}

/** Assemble the twelve clauses (eleven live + one VOID), schema-validate every
 *  assertion, and refuse duplicates — a malformed clause set is a fatal error,
 *  never a silently-skipped clause. Exported for the integration suite. */
export function buildAssertions(deps: Df5GateDeps): GateAssertion[] {
  const all: GateAssertion[] = [
    ...df5ExecutionAssertions({ runId: deps.runId, runsDir: deps.runsDir }),
    ...df5BoundaryAssertions({
      runId: deps.runId,
      runsDir: deps.runsDir,
      gitDir: deps.gitDir,
      reverifyDir: deps.reverifyDir,
      prBodyFile: deps.prBody,
    }),
    ...df5AccountingAssertions({
      runId: deps.runId,
      runsDir: deps.runsDir,
      auditDb: deps.auditDb,
      ledger: deps.ledger,
      reverifyDir: deps.reverifyDir,
    }),
  ];
  const ids = new Set<string>();
  for (const assertion of all) {
    const parsed = GateAssertionSchema.safeParse(assertion);
    if (!parsed.success) {
      throw new Error(`assertion ${assertion.id ?? "<no id>"} fails GateAssertionSchema: ${parsed.error.message}`);
    }
    if (ids.has(assertion.id)) throw new Error(`duplicate assertion id: ${assertion.id}`);
    ids.add(assertion.id);
  }
  return all;
}

/** `[PASS|FAIL|SKIP|VOID] id (story, prd_clause) Xms` + indented detail, then
 *  totals, blocking list, and the terminal marker — phase0-exit-gate.ts render. */
function render(report: GateReport, runId: string): string {
  const lines: string[] = [];
  for (const row of report.assertions) {
    const tag = row.status.toUpperCase();
    lines.push(`[${tag}] ${row.id} (${row.story}, ${row.prd_clause}) ${row.duration_ms}ms`);
    if (row.detail) lines.push(`    ${row.detail}`);
  }
  const s = report.summary;
  lines.push("");
  lines.push(`Totals: ${s.pass} pass, ${s.fail} fail, ${s.skip} skip, ${s.void} void (${report.assertions.length} clauses)`);
  const blocking = report.assertions.filter((r) => r.status === "fail" || r.status === "skip");
  if (blocking.length > 0) {
    lines.push("Blocking assertions:");
    for (const row of blocking) lines.push(`  ${row.id} — ${row.detail ?? "no detail"}`);
    lines.push(`  remediation: re-run bun scripts/df5-lights-on-gate.ts --run-id ${runId} --report <path> after restoring the named evidence`);
  }
  lines.push(`DF_GATE: ${report.overall}`);
  return lines.join("\n");
}

/** Fresh per-invocation correlation id — minted at gate start, stamped on the
 *  wrapper and every log line (lean-worker-benchmark.ts precedent). Determinism
 *  (AC3) is over per-clause statuses + overall, never over this field. */
function mintRequestId(): string {
  const rand = Math.random().toString(36).slice(2, 6);
  return `df54-${Date.now().toString(36)}-${rand}`;
}

/** The typed code for a blocking row's log line: the first walker/ledger code
 *  shape in the detail (same family as the accounting module's typedCodes —
 *  e.g. `audit-store-absent`), else the honest status default. A skip means
 *  the evidence could not be read at all; a fail means the assertion ran and
 *  did not hold. */
function rowCode(status: GateReport["assertions"][number]["status"], detail: string): string {
  const typed = detail.match(/\b(?:audit-store|audit-chain|ledger)-[a-z]{2,}(?:-[a-z]+)*\b/);
  if (typed) return typed[0];
  return status === "skip" ? "evidence-unreadable" : "assertion-failed";
}

/** Write via a same-dir tmp + renameSync: the rename is atomic on a local
 *  filesystem, so a mid-write fault (ENOSPC, SIGKILL) leaves nothing at the
 *  report path — never truncated JSON at the evidence location while the
 *  process claims exit 2 "no report written". The tmp is unlinked on failure
 *  so the fault doesn't litter the scratch. */
function writeReportAtomically(reportPath: string, body: string): void {
  const tmp = `${reportPath}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    writeFileSync(tmp, body);
    renameSync(tmp, reportPath);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      // the tmp may never have been created — nothing to clean
    }
    throw e;
  }
}

/** Fatal-fault phase: "usage" until the flags validate, then "run" — the gate
 *  execution and the report write are the environment's fault, not a typo, and
 *  the exit-2 label says so. */
let flagsValidated = false;

// dp:ok (main) — the import.meta.main caller wraps main in the exit-2 catch; a throw here is a fatal fault, never a silent crash.
async function main(): Promise<number> {
  const args = parseArgs(Bun.argv.slice(2));
  flagsValidated = true;
  const requestId = mintRequestId();
  const assertions = buildAssertions(args);

  const startedAt = Date.now();
  const report = await runGate(assertions, RUN_OPTIONS);
  const ranInMs = Date.now() - startedAt;

  // The report the chassis produced is contract-shaped before anything claims
  // a verdict, and it goes to disk BEFORE any verdict line is emitted — exit 2
  // from here means nothing was left at the report path and no PASS ever
  // reached stderr, in both directions.
  const validated = GateReportSchema.parse(report);
  const writeStartedAt = Date.now();
  // mkdirSync recursive is idempotent — no existsSync guard (a TOCTOU wait for
  // a race that cannot fail here).
  mkdirSync(dirname(args.report), { recursive: true });
  writeReportAtomically(
    args.report,
    `${JSON.stringify(
      {
        gate: GATE_NAME,
        gate_version: GATE_VERSION,
        clause_map_version: CLAUSE_MAP_VERSION,
        request_id: requestId,
        report: validated,
      },
      null,
      2,
    )}\n`,
  );
  const reportWriteMs = Date.now() - writeStartedAt;
  console.error(
    JSON.stringify({ requestId, gate: GATE_NAME, report_path: args.report, report_write_ms: reportWriteMs, ran_ms: ranInMs }),
  );

  // Observability contract: one structured line per assertion + a summary, on
  // stderr so stdout stays the human table + terminal marker. Emitted only
  // once the report is durably on disk (see above) — a fatal fault never
  // prints PASS.
  for (const row of report.assertions) {
    console.error(
      JSON.stringify({
        requestId,
        gate: GATE_NAME,
        assertionId: row.id,
        story: row.story,
        status: row.status,
        duration_ms: row.duration_ms,
        ...(row.status === "fail" || row.status === "skip"
          ? {
              code: rowCode(row.status, row.detail ?? ""),
              message: row.detail ?? "",
              remediation: `inspect the named evidence paths, then re-run: bun scripts/df5-lights-on-gate.ts --run-id ${args.runId}`,
            }
          : {}),
      }),
    );
  }
  console.error(
    JSON.stringify({
      requestId,
      gate: GATE_NAME,
      overall: report.overall,
      pass: report.summary.pass,
      fail: report.summary.fail,
      skip: report.summary.skip,
      void: report.summary.void,
      total_duration_ms: report.total_duration_ms,
    }),
  );

  console.log(render(report, args.runId));
  console.error(`gate report written to ${args.report}`);
  const code = report.overall === "PASS" ? 0 : 1;
  process.exitCode = code;
  return code;
}

if (import.meta.main) {
  try {
    await main();
  } catch (e) {
    // A fatal concludes nothing — exit 2, nothing left at --report, no verdict
    // claimed. The phase decides the label: a bad flag is the caller's typo
    // ("usage … try --help"); once the flags validate, the same fault is the
    // environment (locked store, full disk, budget) and gets an honest
    // remediation instead of a pointer back at --help.
    const message = e instanceof Error ? e.message : String(e);
    exitWithFailure(
      flagsValidated ? "df5-lights-on-gate: error" : "df5-lights-on-gate: usage",
      2,
      flagsValidated
        ? [message, "no verdict was claimed and no report was left at the --report path; fix the named fault, then re-run"]
        : [message, "try --help"],
    );
  }
}
