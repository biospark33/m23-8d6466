#!/usr/bin/env bun
/**
 * CLI: backfill the historical machine-parseable triage ledgers into corpus
 * records.
 *
 *   bun scripts/corpus/backfill.ts [--dir <ledger root>] [--out <corpus dir>] [--include-excluded]
 *
 * Defaults: `--dir _bmad-output/workflow-state/code-review`, `--out
 * _bmad-output/judgment/corpus/`. Every record is labeled
 * `agreement-with-claude` — labeler records WHO labelled (provenance class),
 * never whether the label is ground truth (§3.11: historical labels were
 * LLM-lead-generated agreements).
 *
 * Honesty rules (INV-C4, the one backfill timestamp rule):
 *  - `created_at` is a day-granular date read from a recognized ledger
 *    metadata `Date:` line when the ledger states one, else null — never the
 *    first date anywhere in the file (a finding cell can carry an unrelated
 *    date), never the directory name, never an invented intraday time.
 *  - latency/cost/outcome fields are always null — never reconstructed.
 *  - A ledger cell that does not match a known disposition alias (including
 *    bare `N`, as seen in pr128-r5) is skipped-WITH-REASON in the yield report,
 *    never guessed. A compound cell (`DN→P`) maps to the FINAL state with the
 *    full compound preserved verbatim in `rationale`.
 *
 * Exclusions are data, not a regex guess: the three bot-prose transcripts are
 * skipped by name (INV-C2/INV-7), and the three raw pre-triage directories are
 * skipped by directory name (story AC4b); `--include-excluded` lifts both
 * fences for forensics.
 * The read-test-append runs under `scripts/lib/run-lock.ts`. Exit: 0 backfilled
 * (skips are reported, not fatal), 2 fatal (bad root / unwritable out).
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { exitWithFailure, parseValueFlags, tokenizeArgs } from "../lib/cli-args.ts";
import { acquireRunLock, releaseRunLock } from "../lib/run-lock.ts";
import { appendRecord, CORPUS_LOCK_ID } from "./merge.ts";
import { TriageRecordSchema, type Disposition, type TriageRecord } from "./schema.ts";

export const DEFAULT_LEDGER_ROOT = "_bmad-output/workflow-state/code-review";
export const DEFAULT_CORPUS_DIR = "_bmad-output/judgment/corpus";
/** Backfill labeler — the provenance class, never presented as ground truth. */
export const BACKFILL_LABELER = "agreement-with-claude";

/**
 * Bot-comment transcripts (feedback-run INV-7 prose) — never corpus content.
 * Data, not a regex guess; matched against `<dir>/<file>` relative to the
 * ledger root.
 */
export const EXCLUDED_LEDGER_FILES: readonly string[] = [
  "pr135/pr-comment.md",
  "pr135/pr-comment-round7.md",
  "pr184/HANDOFF-round2.md",
];

/**
 * Raw pre-triage directories (story jev-1 AC4b): never ledgers, never parsed.
 * Data, not a regex guess — `e2e-audit` tables are one `id`-column away from
 * emitting false agreement-with-claude records. `--include-excluded` lifts the
 * fence for forensics, same as the file fence.
 */
export const EXCLUDED_LEDGER_DIRS: readonly string[] = ["df1-10-r6", "e2e-audit", "pr185"];

/** The alias table from the story: P/PATCH, D/DEFER, X/DISMISS, DN/DECISION_NEEDED, POST_MERGE_CHANGED. Everything else — bare `N` included — is skipped-with-reason. */
const ALIASES: Record<string, Disposition> = {
  P: "PATCH",
  PATCH: "PATCH",
  D: "DEFER",
  DEFER: "DEFER",
  X: "DISMISS",
  DISMISS: "DISMISS",
  DN: "DECISION_NEEDED",
  DECISION_NEEDED: "DECISION_NEEDED",
  POST_MERGE_CHANGED: "POST_MERGE_CHANGED",
};

const SECTION_KEYWORDS: [keyword: string, disposition: Disposition][] = [
  ["decision", "DECISION_NEEDED"],
  ["dismiss", "DISMISS"],
  ["defer", "DEFER"],
  ["patch", "PATCH"],
];

const SEV_PREFIX_RE = /^\s*(BLOCKER|HIGH|MEDIUM|MED|LOW|INFO)\b/i;

export interface BackfillArgs {
  dir?: string;
  out?: string;
  includeExcluded?: boolean;
}

export function parseArgs(argv: string[]): BackfillArgs {
  const out: BackfillArgs = {};
  const { flagTokens, bools } = tokenizeArgs(argv, { valueFlags: ["--dir", "--out"], boolFlags: ["--include-excluded"] });
  parseValueFlags(flagTokens, {
    flags: ["--dir", "--out"],
    onValue: (flag, v) => {
      if (flag === "--dir") out.dir = v;
      else out.out = v;
    },
    help: [
      "Usage: backfill [--dir <ledger root>] [--out <corpus dir>] [--include-excluded]",
      "",
      "Parses the historical triage.md ledgers into agreement-with-claude corpus",
      "records. Bot-prose transcripts are excluded by name (INV-C2);",
      "--include-excluded lifts that fence for forensics only.",
      "",
      "Exit: 0 backfilled (skips reported) · 2 fatal",
      "",
    ],
  });
  out.includeExcluded = bools.has("--include-excluded");
  return out;
}

/**
 * Normalize one ledger disposition cell: strip markdown emphasis, peel a
 * trailing parenthetical annotation, split a trailing em-dash rationale, map a
 * compound (`DN→X`) to its FINAL state. Returns null when the code matches no
 * alias — the caller skips the row with a reason instead of guessing.
 */
export function normalizeDispositionCell(cell: string): { disposition: Disposition; rationale?: string } | null {
  let s = cell.trim();
  if (s === "") return null;
  const rationaleParts: string[] = [];
  // Trailing parenthetical annotation — `"**P** (comment)"` → code + "comment".
  const paren = s.indexOf("(");
  if (paren > 0 && s.endsWith(")")) {
    rationaleParts.push(s.slice(paren + 1, -1).trim());
    s = s.slice(0, paren).trim();
  }
  // Trailing em-dash rationale — `"**D** — because …"` → code + the reason.
  const dash = s.search(/\s[—–]\s/);
  if (dash > 0) {
    rationaleParts.push(s.slice(dash).replace(/^\s[—–]\s/, "").trim());
    s = s.slice(0, dash).trim();
  }
  // Markdown emphasis, peels only now that wrappers around the WHOLE cell are gone.
  s = s.replace(/^\*{1,2}/, "").replace(/\*{1,2}$/, "").trim();
  // Compound cell — `"DN→P"` maps to the FINAL state; the compound rides verbatim in rationale.
  const compound = s.includes("→") ? s : undefined;
  if (compound !== undefined) {
    rationaleParts.unshift(compound);
    s = compound.slice(compound.lastIndexOf("→") + 1).trim();
  }
  if (s === "") return null;
  const disposition = ALIASES[s.toUpperCase()];
  if (disposition === undefined) return null;
  const rationale = rationaleParts.filter((p) => p !== "").join("; ");
  return rationale === "" ? { disposition } : { disposition, rationale };
}

/** The disposition a section heading implies, when the table carries no disposition column. */
function sectionDisposition(section: string): Disposition | null {
  const s = section.toLowerCase();
  for (const [keyword, disposition] of SECTION_KEYWORDS) {
    if (s.includes(keyword)) return disposition;
  }
  return null;
}

/**
 * A recognized ledger metadata `Date:` line (bold tolerated, blockquote
 * tolerated). NEVER the first date anywhere in the file — a finding cell can
 * legitimately carry an unrelated date, and pr184 round 4 proved it live:
 * finding A1's `[ "2026-09-02" \> "null" ]` shell snippet stamped all 108
 * records. No metadata date → null (INV-C4: never guessed).
 */
const LEDGER_DATE_RE = /^\s*>?\s*\**\s*date\b\**?\s*:\s*\**\s*(20\d{2}-\d{2}-\d{2})\b/im;

export function ledgerDate(text: string): string | null {
  const m = text.match(LEDGER_DATE_RE);
  if (!m || Number.isNaN(Date.parse(m[1]!))) return null;
  return m[1]!;
}

export function derivePr(dirName: string): number | null {
  const m = dirName.match(/^pr(\d+)(?:-r\d+)?$/);
  return m ? Number(m[1]!) : null;
}

export function deriveRound(dirName: string, fileName: string): number | null {
  const f = fileName.match(/round(\d+)/);
  if (f) return Number(f[1]!);
  const d = dirName.match(/(?:^round|-r)(\d+)$/);
  if (d) return Number(d[1]!);
  return null;
}

export interface LedgerMeta {
  pr: number | null;
  round: number | null;
  /** Ledger-relative path — the honest fallback diff_context_ref pointer. */
  sourceRef: string;
  createdAt: string | null;
}

export interface LedgerParse {
  records: TriageRecord[];
  rows: number;
  skipped: { id: string | null; reason: string }[];
}

function cells(line: string): string[] {
  // Markdown-aware: `\|` is a literal pipe INSIDE a cell, not a column break —
  // a plain split("|") shifts/truncates finding_text when a cell quotes shell
  // (`[ "a" \| "b" ]`). The escape is consumed, matching how the row renders.
  const parts: string[] = [];
  let cur = "";
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === "\\" && line[i + 1] === "|") {
      cur += "|";
      i++;
    } else if (ch === "|") {
      parts.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  parts.push(cur);
  return parts.slice(1, -1).map((c) => c.trim());
}

function isTableSeparator(line: string): boolean {
  return /^\|(\s*:?-{3,}:?\s*\|)+$/.test(line.trim());
}

/**
 * Parse one ledger file's pipe tables. Header-driven (finding/title column
 * required; class/disposition column optional), so the encoding variants
 * (pr123 word forms, pr184 letter+bold+compound, pr128-r5 section-implied)
 * share one parser and anything else is skipped-with-reason.
 */
export function parseLedgerText(text: string, meta: LedgerMeta): LedgerParse {
  const lines = text.split("\n");
  const records: TriageRecord[] = [];
  const skipped: { id: string | null; reason: string }[] = [];
  let rows = 0;
  let section = "";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const heading = line.match(/^#{1,6}\s+(.*)$/);
    if (heading) {
      section = heading[1]!;
      continue;
    }
    if (!line.trim().startsWith("|") || i + 1 >= lines.length || !isTableSeparator(lines[i + 1]!)) continue;
    const header = cells(line);
    const find = (names: string[]): number => header.findIndex((h) => names.includes(h.toLowerCase()));
    const idCol = find(["#", "id"]);
    const sevCol = find(["sev"]);
    const findingCol = find(["finding", "title"]);
    const dispCol = find(["class", "disposition"]);
    const locCol = find(["location"]);
    i += 2;
    if (findingCol === -1) {
      skipped.push({ id: null, reason: `table skipped: no finding/title column (header: ${header.join(", ")})` });
      continue;
    }
    for (; i < lines.length && lines[i]!.trim().startsWith("|"); i++) {
      const row = cells(lines[i]!);
      rows++;
      const id = idCol >= 0 ? (row[idCol] ?? "") : "";
      if (id === "") {
        skipped.push({ id: null, reason: "row skipped: no id cell" });
        continue;
      }
      const finding = row[findingCol] ?? "";
      if (finding === "") {
        skipped.push({ id, reason: "row skipped: empty finding cell" });
        continue;
      }
      let disposition: Disposition;
      let rationale: string | undefined;
      if (dispCol >= 0) {
        const norm = normalizeDispositionCell(row[dispCol] ?? "");
        if (norm === null) {
          skipped.push({ id, reason: `row skipped: unknown disposition code "${row[dispCol] ?? ""}" — never guessed` });
          continue;
        }
        disposition = norm.disposition;
        rationale = norm.rationale;
      } else {
        const implied = sectionDisposition(section);
        if (implied === null) {
          skipped.push({ id, reason: `row skipped: no disposition column and section "${section}" implies none` });
          continue;
        }
        disposition = implied;
      }
      const sevCell = sevCol >= 0 ? (row[sevCol] ?? "") : "";
      const sevPrefix = finding.match(SEV_PREFIX_RE);
      const label = sevCell !== "" ? sevCell : sevPrefix !== null ? sevPrefix[1]!.toUpperCase() : "unspecified";
      const locCell = locCol >= 0 ? (row[locCol] ?? "") : "";
      const record = TriageRecordSchema.safeParse({
        finding_id: id,
        finding_text: finding,
        diff_context_ref: locCell !== "" ? locCell : `${meta.sourceRef}#${id}`,
        label,
        disposition,
        ...(rationale !== undefined ? { rationale } : {}),
        labeler: BACKFILL_LABELER,
        pr: meta.pr,
        round: meta.round,
        created_at: meta.createdAt,
        arm: "frontier",
        latency_ms: null,
        cost_exact_usd: null,
        cost_estimate_usd: null,
        outcome_confirmed: null,
        outcome_source: null,
      });
      if (!record.success) {
        skipped.push({ id, reason: `row skipped: record failed schema — ${record.error.issues.map((x) => x.message).join("; ")}` });
        continue;
      }
      records.push(record.data);
    }
    i--;
  }
  return { records, rows, skipped };
}

interface FileYield {
  rel: string;
  rows: number;
  records: TriageRecord[];
  skipped: { id: string | null; reason: string }[];
}

export async function main(argv: string[]): Promise<number> {
  try {
    const args = parseArgs(argv);
    const root = args.dir ?? DEFAULT_LEDGER_ROOT;
    if (!existsSync(root) || !statSync(root).isDirectory()) {
      exitWithFailure("corpus-backfill:", 2, [`ledger root not found: ${root}`]);
    }
    const outDir = args.out ?? DEFAULT_CORPUS_DIR;
    mkdirSync(outDir, { recursive: true });
    const report: string[] = [];
    const yields: FileYield[] = [];
    let excluded = 0;
    let nonDirectory = 0;
    let unbackable = 0;
    const entries = readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        // INV-C2 adjacent: a stray file (e.g. df3-3-selfreview.diff) is reported, never read.
        nonDirectory++;
        report.push(`skipped non-directory (never read): ${entry.name}`);
        continue;
      }
      const dirName = entry.name;
      if (!args.includeExcluded && EXCLUDED_LEDGER_DIRS.includes(dirName)) {
        excluded++;
        report.push(`dir ${dirName}: EXCLUDED (raw pre-triage — story AC4b); pass --include-excluded for forensics`);
        continue;
      }
      const files = readdirSync(join(root, dirName), { withFileTypes: true })
        .filter((f) => f.isFile() && f.name.endsWith(".md"))
        .map((f) => f.name)
        .sort();
      if (files.length === 0) {
        unbackable++;
        report.push(`dir ${dirName}: unbackable (no top-level .md ledger files)`);
        continue;
      }
      let dirRecords = 0;
      for (const file of files) {
        const rel = `${dirName}/${file}`;
        if (!args.includeExcluded && EXCLUDED_LEDGER_FILES.includes(rel)) {
          excluded++;
          report.push(`file ${rel}: EXCLUDED (bot-prose transcript — INV-C2); pass --include-excluded for forensics`);
          continue;
        }
        const text = readFileSync(join(root, dirName, file), "utf8");
        const parsed = parseLedgerText(text, {
          pr: derivePr(dirName),
          round: deriveRound(dirName, file),
          sourceRef: rel,
          createdAt: ledgerDate(text),
        });
        dirRecords += parsed.records.length;
        yields.push({ rel, rows: parsed.rows, records: parsed.records, skipped: parsed.skipped });
        for (const s of parsed.skipped) report.push(`file ${rel}: skipped ${s.id ?? "?"}: ${s.reason}`);
      }
      if (dirRecords === 0) {
        unbackable++;
        report.push(`dir ${dirName}: unbackable (0 records from ${files.length} candidate .md files)`);
      }
    }
    const lock = acquireRunLock(outDir, CORPUS_LOCK_ID, "corpus backfill");
    let written = 0;
    let duplicates = 0;
    try {
      for (const y of yields) {
        for (const record of y.records) {
          if (appendRecord(outDir, record) === "written") written++;
          else duplicates++;
        }
      }
    } finally {
      releaseRunLock(lock);
    }
    for (const line of report) console.log(line);
    const totalRows = yields.reduce((n, y) => n + y.rows, 0);
    const totalRecords = yields.reduce((n, y) => n + y.records.length, 0);
    process.stdout.write(
      `corpus-backfill: ${root} -> ${outDir}: ${yields.length} files, ${totalRows} rows parsed, ${totalRecords} records emitted ` +
        `(${written} written, ${duplicates} duplicate-skipped), ${excluded} excluded, ${nonDirectory} non-directory, ${unbackable} unbackable\n`,
    );
    return 0;
  } catch (e) {
    exitWithFailure("corpus-backfill:", 2, [(e as Error).message]);
  }
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
