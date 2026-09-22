#!/usr/bin/env bun
/**
 * CLI: the §3.12 A/B measurement report (JEV-4, handoff §7 Wave 4) — one
 * command renders the speed/performance/cost table over corpus JSONL files.
 *
 *   bun scripts/judgment/ab-report.ts --pr <n> --round <n> [--corpus-dir <dir>] [--json]
 *   bun scripts/judgment/ab-report.ts --all        [--corpus-dir <dir>] [--json]
 *
 * Frontier records (arm="frontier") join jev records (arm="jev") on
 * (pr, round, finding_id). Sections:
 *
 *  PERFORMANCE — jev-vs-frontier disposition agreement (exact match) over
 *    paired findings, plus an is_real_defect x disposition cross-tab parsed
 *    from the jev rationale clause ("jev: is_real_defect=...; ..."). A record
 *    without the clause is reported "not-recorded", never guessed.
 *  SPEED — latency_ms per arm: count, mean, median, min, max; nulls are
 *    counted as not-recorded and never imputed.
 *  COST — jev sums cost_exact_usd (exact, from usage); frontier sums
 *    cost_estimate_usd, labeled estimate and never presented as metered
 *    (§3.12 wording discipline).
 *  OUTCOME-VALIDATED PRECISION — agreement-with-outcome rates per arm once
 *    outcome_confirmed/outcome_source populate; while every outcome is null
 *    the section reads "not yet available — outcome fields unpopulated".
 *
 * This script RENDERS DATA and judges nothing: no threshold, no routing, no
 * gate authority (§3.5), and it does not import the judgment client — the
 * probabilities stay parsed text in rationale strings, read here by code.
 * Exit: 0 any readable input · 2 malformed corpus files (named error).
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseValueFlags, tokenizeArgs } from "../lib/cli-args.ts";
import { DEFAULT_CORPUS_DIR, corpusFilePath, readRecords } from "../corpus/merge.ts";
import { DISPOSITIONS, type TriageRecord } from "../corpus/schema.ts";

export interface AbArgs {
  pr?: number;
  round?: number;
  corpusDir?: string;
  all?: boolean;
  json?: boolean;
}

export function parseArgs(argv: string[]): AbArgs {
  let pr: number | undefined;
  let round: number | undefined;
  let corpusDir: string | undefined;
  let all = false;
  let json = false;
  const valueFlags = ["--pr", "--round", "--corpus-dir"] as const;
  const { flagTokens, bools } = tokenizeArgs(argv, { valueFlags: [...valueFlags], boolFlags: ["--all", "--json"] });
  all = bools.has("--all");
  json = bools.has("--json");
  parseValueFlags(flagTokens, {
    flags: [...valueFlags],
    onValue: (flag, v) => {
      if (flag === "--pr") pr = Number(v);
      else if (flag === "--round") round = Number(v);
      else corpusDir = v;
    },
    help: [
      "Usage: ab-report --pr <n> --round <n> [--corpus-dir <dir>] [--json]",
      "       ab-report --all [--corpus-dir <dir>] [--json]",
      "",
      "Renders the §3.12 A/B speed/performance/cost table from corpus JSONL",
      "files. --all iterates every *.jsonl in the corpus dir (join key",
      "(pr, round, finding_id)). Data only — no threshold, no gate.",
      "",
      "Exit: 0 readable input · 2 malformed corpus files",
      "",
    ],
  });
  if ((pr === undefined) !== (round === undefined)) {
    throw new Error("--pr and --round go together (or use --all for every corpus file)");
  }
  if (all && pr !== undefined) {
    throw new Error("--all is mutually exclusive with --pr/--round");
  }
  return { pr, round, corpusDir, all, json };
}

// ---------------------------------------------------------------------------
// Scope loading
// ---------------------------------------------------------------------------

export interface Scope {
  /** Corpus files read (basename for --all). */
  files: string[];
  frontier: TriageRecord[];
  jev: TriageRecord[];
}

function readArmPartition(file: string): { frontier: TriageRecord[]; jev: TriageRecord[] } {
  const frontier: TriageRecord[] = [];
  const jev: TriageRecord[] = [];
  for (const r of readRecords(file)) {
    if (r.arm === "jev") jev.push(r);
    else frontier.push(r);
  }
  return { frontier, jev };
}

/** Read one round's file, or with pr/round undefined every *.jsonl in the dir. */
export function loadScope(corpusDir: string, pr?: number, round?: number): Scope {
  if (pr === undefined || round === undefined) {
    let names: string[];
    try {
      names = readdirSync(corpusDir).filter((n) => n.endsWith(".jsonl")).sort();
    } catch {
      throw new Error(`no corpus dir at ${corpusDir} — nothing to report (pass --corpus-dir or run a merge first)`);
    }
    const frontier: TriageRecord[] = [];
    const jev: TriageRecord[] = [];
    for (const n of names) {
      const part = readArmPartition(join(corpusDir, n));
      frontier.push(...part.frontier);
      jev.push(...part.jev);
    }
    return { files: names, frontier, jev };
  }
  const file = corpusFilePath(corpusDir, pr, round);
  if (!existsSync(file)) {
    return { files: [], frontier: [], jev: [] };
  }
  const part = readArmPartition(file);
  return { files: [file], frontier: part.frontier, jev: part.jev };
}

// ---------------------------------------------------------------------------
// Computation (pure — testable without the CLI)
// ---------------------------------------------------------------------------

export interface LatencyStats {
  n: number;
  nulls: number;
  mean: number | null;
  median: number | null;
  min: number | null;
  max: number | null;
}

/** §3.12 speed stats over `latency_ms`: nulls counted, never imputed. */
export function latencyStats(records: TriageRecord[]): LatencyStats {
  const ms = records.map((r) => r.latency_ms).filter((v): v is number => typeof v === "number");
  const nulls = records.length - ms.length;
  if (ms.length === 0) return { n: 0, nulls, mean: null, median: null, min: null, max: null };
  const sorted = [...ms].sort((a, b) => a - b);
  const mid = sorted.length / 2;
  const median = Number.isInteger(mid) ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[Math.floor(mid)]!;
  const sum = ms.reduce((a, b) => a + b, 0);
  return {
    n: ms.length,
    nulls,
    mean: sum / ms.length,
    median,
    min: sorted[0]!,
    max: sorted[sorted.length - 1]!,
  };
}

/**
 * The is_real_defect clause of a jev rationale; absent clause = not-recorded
 * (never guessed). noul is a probability (0=no … 1=yes, live-verified
 * 2026-09-22); the cross-tab renders the MAJORITY READ (p > 0.5 = yes) — the
 * mathematically canonical binary read, stated in the report, with no gating
 * use anywhere. Legacy boolean-era rationales still parse.
 */
export function parseIsRealDefect(rationale: string | undefined): "true" | "false" | "not-recorded" {
  const n = rationale?.match(/jev: is_real_defect=([0-9]+(?:\.[0-9]+)?)/);
  if (n) return Number.parseFloat(n[1]!) > 0.5 ? "true" : "false";
  const b = rationale?.match(/jev: is_real_defect=(true|false)/);
  return b ? (b[1] as "true" | "false") : "not-recorded";
}

const IS_REAL_DEFECT_ROWS = ["true", "false", "not-recorded"] as const;

export interface CrossTabRow {
  is_real_defect: (typeof IS_REAL_DEFECT_ROWS)[number];
  total: number;
  [disposition: string]: number | string;
}

export interface CostArm {
  basis: "exact" | "estimate";
  n: number;
  nulls: number;
  totalUsd: number | null;
}

export interface OutcomeArm {
  arm: "frontier" | "jev";
  confirmed: number;
  confirmedTrue: number;
  confirmedFalse: number;
  agreed: number;
  rate: number | null;
  sources: Record<string, number>;
}

export interface AbReport {
  files: string[];
  paired: { paired: number; agreed: number; rate: number | null };
  crosstab: CrossTabRow[];
  speed: { jev: LatencyStats; frontier: LatencyStats };
  cost: { jev: CostArm; frontier: CostArm };
  outcome: { available: boolean; perArm: OutcomeArm[] };
}

/**
 * The outcome agreement rule, stated rather than thresholded: a
 * confirmed-true outcome agrees with every disposition except DISMISS (the
 * finding was real after all), and a confirmed-false outcome agrees with
 * DISMISS. Null outcomes are excluded from the rates and counted in
 * `confirmed` never — they simply stay out of scope of this section.
 */
export function outcomeAgrees(disposition: string, outcome_confirmed: boolean): boolean {
  return outcome_confirmed ? disposition !== "DISMISS" : disposition === "DISMISS";
}

function byJoinKey(records: TriageRecord[], what: string): Map<string, TriageRecord> {
  const map = new Map<string, TriageRecord>();
  for (const r of records) {
    const key = `${r.pr}|${r.round}|${r.finding_id}`;
    if (map.has(key)) throw new Error(`duplicate ${what} record for join key (${key}) — cannot join unambiguously`);
    map.set(key, r);
  }
  return map;
}

export function computeReport(frontier: TriageRecord[], jev: TriageRecord[]): AbReport {
  const frontierByKey = byJoinKey(frontier, "frontier");
  const jevByKey = byJoinKey(jev, "jev");

  let paired = 0;
  let agreed = 0;
  for (const [key, j] of jevByKey) {
    const f = frontierByKey.get(key);
    if (!f) continue;
    paired++;
    if (j.disposition === f.disposition) agreed++;
  }

  const crosstab: CrossTabRow[] = [];
  for (const row of IS_REAL_DEFECT_ROWS) {
    const inRow = jev.filter((r) => parseIsRealDefect(r.rationale) === row);
    if (inRow.length === 0) continue;
    const entry: CrossTabRow = { is_real_defect: row, total: inRow.length };
    for (const d of DISPOSITIONS) {
      const n = inRow.filter((r) => r.disposition === d).length;
      if (n > 0) entry[d] = n;
    }
    crosstab.push(entry);
  }

  const costArm = (records: TriageRecord[], basis: "exact" | "estimate"): CostArm => {
    const field = basis === "exact" ? "cost_exact_usd" : "cost_estimate_usd";
    const vals = records.map((r) => r[field]).filter((v): v is number => typeof v === "number");
    return {
      basis,
      n: vals.length,
      nulls: records.length - vals.length,
      totalUsd: vals.length === 0 ? null : vals.reduce((a, b) => a + b, 0),
    };
  };

  const outcomeArm = (arm: "frontier" | "jev", records: TriageRecord[]): OutcomeArm | null => {
    const withOutcome = records.filter((r) => typeof r.outcome_confirmed === "boolean");
    if (withOutcome.length === 0) return null;
    const confirmedTrue = withOutcome.filter((r) => r.outcome_confirmed === true).length;
    const agreed = withOutcome.filter((r) => outcomeAgrees(r.disposition, r.outcome_confirmed as boolean)).length;
    const sources: Record<string, number> = {};
    for (const r of withOutcome) {
      if (r.outcome_source !== null) sources[r.outcome_source] = (sources[r.outcome_source] ?? 0) + 1;
    }
    return {
      arm,
      confirmed: withOutcome.length,
      confirmedTrue,
      confirmedFalse: withOutcome.length - confirmedTrue,
      agreed,
      rate: agreed / withOutcome.length,
      sources,
    };
  };
  const jevOutcome = outcomeArm("jev", jev);
  const frontierOutcome = outcomeArm("frontier", frontier);

  return {
    files: [],
    paired: { paired, agreed, rate: paired === 0 ? null : agreed / paired },
    crosstab,
    speed: { jev: latencyStats(jev), frontier: latencyStats(frontier) },
    cost: { jev: costArm(jev, "exact"), frontier: costArm(frontier, "estimate") },
    outcome: { available: jevOutcome !== null || frontierOutcome !== null, perArm: [jevOutcome, frontierOutcome].filter((o) => o !== null) },
  };
}

// ---------------------------------------------------------------------------
// Rendering (fixed-width text / JSON)
// ---------------------------------------------------------------------------

function pct(rate: number | null): string {
  return rate === null ? "n/a" : `${(rate * 100).toFixed(1)}%`;
}

function num(v: number | null): string {
  return v === null ? "-" : String(Number.isInteger(v) ? v : +v.toFixed(1));
}

const pad = (s: string, w: number) => s.padEnd(w);
const padL = (s: string, w: number) => s.padStart(w);

export function renderText(report: AbReport, scope: string): string {
  const lines: string[] = [];
  lines.push(`== §3.12 A/B REPORT — ${scope} ==`);
  if (report.files.length > 0) lines.push(`corpus files: ${report.files.join(", ")}`);

  lines.push("");
  lines.push(`PERFORMANCE — jev vs frontier disposition agreement (exact match), ${report.paired.paired} paired findings`);
  lines.push(`  agreed ${report.paired.agreed}/${report.paired.paired} (${pct(report.paired.rate)})`);
  if (report.crosstab.length === 0) {
    lines.push("  is_real_defect x disposition: no jev-arm records in scope");
  } else {
    const cols = DISPOSITIONS.filter((d) => report.crosstab.some((r) => r[d] !== undefined));
    const rowW = Math.max("is_real_defect".length, ...IS_REAL_DEFECT_ROWS.map((r) => r.length));
    lines.push("  is_real_defect x disposition (jev rationale clause; absent = not-recorded, never guessed):");
    lines.push("    verdict rule: noul p > 0.5 = yes (majority read, stated; no gating use)");
    lines.push(`    ${pad("is_real_defect", rowW)}  ${cols.map((c) => padL(c, c.length + 1)).join("")}${padL("total", 8)}`);
    for (const r of report.crosstab) {
      const cells = cols.map((c) => padL(r[c] === undefined ? "0" : String(r[c]), c.length + 1)).join("");
      lines.push(`    ${pad(r.is_real_defect, rowW)}  ${cells}${padL(String(r.total), 8)}`);
    }
  }

  lines.push("");
  lines.push("SPEED — latency_ms (nulls reported as not-recorded; never imputed)");
  const sW = Math.max("frontier".length, 9);
  const head = `  ${pad("arm", sW)}  ${padL("n", 4)}  ${padL("not-recorded", 13)}  ${padL("mean", 9)}  ${padL("median", 9)}  ${padL("min", 9)}  ${padL("max", 9)}`;
  lines.push(head);
  for (const [arm, s] of [["jev", report.speed.jev], ["frontier", report.speed.frontier]] as const) {
    lines.push(
      `  ${pad(arm, sW)}  ${padL(String(s.n), 4)}  ${padL(String(s.nulls), 13)}  ${padL(num(s.mean), 9)}  ${padL(num(s.median), 9)}  ${padL(num(s.min), 9)}  ${padL(num(s.max), 9)}`,
    );
  }

  lines.push("");
  lines.push("COST — USD (arm bases differ: jev is metered, frontier is an estimate — never conflated)");
  lines.push(`  jev       basis: exact (from usage)${" ".repeat(28)}n=${report.cost.jev.n}  not-recorded=${report.cost.jev.nulls}  total_usd=${report.cost.jev.totalUsd === null ? "-" : report.cost.jev.totalUsd.toFixed(8)}`);
  lines.push(
    `  frontier  basis: estimate (from session duration model — never metered)  n=${report.cost.frontier.n}  not-recorded=${report.cost.frontier.nulls}  total_usd=${report.cost.frontier.totalUsd === null ? "-" : report.cost.frontier.totalUsd.toFixed(8)}`,
  );

  lines.push("");
  if (!report.outcome.available) {
    lines.push("OUTCOME-VALIDATED PRECISION");
    lines.push("  not yet available — outcome fields unpopulated");
  } else {
    lines.push("OUTCOME-VALIDATED PRECISION — agreement with outcome per arm");
    lines.push("  rule: confirmed-true agrees with every disposition except DISMISS; confirmed-false agrees with DISMISS");
    const oW = Math.max("frontier".length, 9);
    lines.push(`  ${pad("arm", oW)}  ${padL("confirmed", 9)}  ${padL("true", 5)}  ${padL("false", 5)}  ${padL("agreed", 6)}  rate  sources`);
    for (const o of report.outcome.perArm) {
      const src = Object.entries(o.sources).map(([k, v]) => `${k}=${v}`).join(", ") || "-";
      lines.push(
        `  ${pad(o.arm, oW)}  ${padL(String(o.confirmed), 9)}  ${padL(String(o.confirmedTrue), 5)}  ${padL(String(o.confirmedFalse), 5)}  ${padL(String(o.agreed), 6)}  ${o.agreed}/${o.confirmed} (${pct(o.rate)})  ${src}`,
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

export async function main(argv: string[]): Promise<number> {
  try {
    const args = parseArgs(argv);
    const scope = loadScope(args.corpusDir ?? DEFAULT_CORPUS_DIR, args.pr, args.round);
    const report = computeReport(scope.frontier, scope.jev);
    report.files = scope.files;
    const scopeLabel = args.all ? "all corpus files" : `pr ${args.pr} round ${args.round}`;
    process.stdout.write(args.json ? `${JSON.stringify(report, null, 2)}\n` : renderText(report, scopeLabel));
    return 0;
  } catch (e) {
    process.stderr.write(`ab-report: ${(e as Error).message}\n`);
    return 2;
  }
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
