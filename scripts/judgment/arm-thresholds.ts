#!/usr/bin/env bun
/**
 * CLI: the J2 arm gate over the real corpus (AC1/AC3) — dry-run verdict by
 * default; the operator's signed `--arm` / `--unarm` flip appends one
 * hash-chained entry to `<judgment-dir>/arm-state.jsonl`.
 *
 *   bun scripts/judgment/arm-thresholds.ts [--corpus-dir <dir>] [--judgment-dir <dir>]
 *   bun scripts/judgment/arm-thresholds.ts --arm   --sign-off "<who when>" [--corpus-dir <dir>] [--judgment-dir <dir>]
 *   bun scripts/judgment/arm-thresholds.ts --unarm --sign-off "<who when>" [--corpus-dir <dir>] [--judgment-dir <dir>]
 *
 * A flip needs the DD-21 sign-off pair AND (for --arm) an eligible verdict,
 * and refuses exit 2 BEFORE ANY WRITE otherwise, naming every gap. The
 * evaluation itself is `src/judgment/arm-gate.ts` (pure, thresholds in
 * code — no env/config/CLI flag can lower them); this script owns corpus
 * reading, the outcome join's file I/O, and the append.
 *
 * shortcut: no run-lock around the read-verify-append — the flip is a
 * single operator-run cold-path append, unlike merge's batched writes; add
 * one if arming ever becomes scripted/automated.
 * Exit: 0 verdict printed / flip appended · 2 fatal before any conclusion.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { exitWithFailure, parseValueFlags, tokenizeArgs } from "../lib/cli-args.ts";
import { DEFAULT_CORPUS_DIR, readRecords } from "../corpus/merge.ts";
import { OutcomeRecordSchema } from "../corpus/schema.ts";
import {
  evaluateGate,
  verifyArmStateLog,
  countedCorpusDigest,
  thresholds,
  type ArmStateEntry,
  type GateCorpusRecord,
  type GateOutcomeEntry,
} from "../../src/judgment/arm-gate.ts";

const DEFAULT_JUDGMENT_DIR = "_bmad-output/judgment";

export interface ArmThresholdsArgs {
  corpusDir?: string;
  judgmentDir?: string;
  arm: boolean;
  unarm: boolean;
  signOff?: string;
}

export function parseArgs(argv: string[]): ArmThresholdsArgs {
  let corpusDir: string | undefined;
  let judgmentDir: string | undefined;
  let signOff: string | undefined;
  const { flagTokens, bools } = tokenizeArgs(argv, {
    valueFlags: ["--corpus-dir", "--judgment-dir", "--sign-off"],
    boolFlags: ["--arm", "--unarm"],
  });
  const arm = bools.has("--arm");
  const unarm = bools.has("--unarm");
  parseValueFlags(flagTokens, {
    flags: ["--corpus-dir", "--judgment-dir", "--sign-off"],
    onValue: (flag, v) => {
      if (flag === "--corpus-dir") corpusDir = v;
      else if (flag === "--judgment-dir") judgmentDir = v;
      else signOff = v;
    },
    help: [
      "Usage: arm-thresholds [--corpus-dir <dir>] [--judgment-dir <dir>]",
      "       arm-thresholds --arm   --sign-off \"<who when>\" [--corpus-dir <dir>] [--judgment-dir <dir>]",
      "       arm-thresholds --unarm --sign-off \"<who when>\" [--corpus-dir <dir>] [--judgment-dir <dir>]",
      "",
      "Dry-run (default) prints the gate verdict JSON — thresholds live in",
      "src/judgment/arm-gate.ts, in code; nothing here can lower them.",
      "",
      "A flip additionally needs the DD-21 sign-off pair: --sign-off non-empty",
      "AND env QDS_JUDGMENT_ARM_CONFIRMED=1. --arm also needs an eligible",
      "verdict. Every refusal is exit 2 before any write, naming its gap.",
      "",
      "Exit: 0 verdict / flip appended · 2 fatal before any conclusion",
      "",
    ],
  });
  if (arm && unarm) throw new Error("--arm and --unarm are mutually exclusive");
  if (!arm && !unarm && signOff !== undefined) throw new Error("--sign-off goes together with --arm or --unarm");
  return { corpusDir, judgmentDir, arm, unarm, signOff };
}

// ---------------------------------------------------------------------------
// Loading (the scripts layer feeds the pure evaluator)
// ---------------------------------------------------------------------------

/** outcomes.jsonl entries; absent file = zero entries; a malformed line is a loud error. */
export function loadOutcomeEntries(corpusDir: string): GateOutcomeEntry[] {
  const file = join(corpusDir, "outcomes.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l, i) => {
      let raw: unknown;
      try {
        raw = JSON.parse(l);
      } catch (e) {
        throw new Error(`outcomes.jsonl line ${i + 1} is not valid JSON: ${(e as Error).message}`);
      }
      const parsed = OutcomeRecordSchema.safeParse(raw);
      if (!parsed.success) throw new Error(`outcomes.jsonl line ${i + 1} failed OutcomeRecordSchema validation: ${parsed.error.issues.map((x) => `${x.path.join(".")}: ${x.message}`).join("; ")}`);
      return parsed.data;
    });
}

/** jev-arm records of every `<pr|x>-r<round>.jsonl` corpus shard (machine-state never enters: readRecords refuses it loudly). */
export function loadJevCorpusRecords(corpusDir: string): GateCorpusRecord[] {
  let names: string[];
  try {
    names = readdirSync(corpusDir);
  } catch {
    return []; // no corpus dir at all: zero confirmed, honestly reported
  }
  const out: GateCorpusRecord[] = [];
  for (const n of names.sort()) {
    // Strict shard grammar `<pr|x>-r<round>.jsonl`: both joinable corpusFilePath
    // forms (the null-pr backfill renders "x"). `<pr>-rx.jsonl` (null round) is
    // excluded — its records can never join an outcome — and the old substring
    // /-r./ admitted foreign names like "notes-round.jsonl".
    if (!/^(\d+|x)-r\d+\.jsonl$/.test(n)) continue;
    for (const r of readRecords(join(corpusDir, n))) {
      // pr/round-null records (x-r*.jsonl backfills) can never join an outcome (positive ints).
      if (r.arm === "jev" && r.pr !== null && r.round !== null) {
        out.push({ pr: r.pr, round: r.round, finding_id: r.finding_id, labeler: r.labeler, disposition: r.disposition });
      }
    }
  }
  return out;
}

/** arm-state.jsonl lines (absent file = []); blank lines dropped before the chain walk. */
function readArmStateLines(judgmentDir: string): string[] {
  const file = join(judgmentDir, "arm-state.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter((l) => l.trim() !== "");
}

/**
 * The current arm state = the log head. Absent/empty log = recording-only
 * (fail-closed); a broken chain refuses — a silent un-arming, splice, or
 * reorder must never be honored.
 */
function readArmState(judgmentDir: string): { state: "recording-only" | "armed"; lastSeq: number; headDigest: string | null } {
  const lines = readArmStateLines(judgmentDir);
  if (lines.length === 0) return { state: "recording-only", lastSeq: 0, headDigest: null };
  const v = verifyArmStateLog(lines);
  if (!v.ok) throw new Error(`arm-state.jsonl fails chain verification — refusing to read state: ${v.reason}`);
  return { state: v.head.to, lastSeq: v.head.seq, headDigest: v.headDigest };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function main(argv: string[]): Promise<number> {
  let args: ArmThresholdsArgs;
  try {
    args = parseArgs(argv);
  } catch (e) {
    exitWithFailure("arm-thresholds:", 2, [(e as Error).message]);
  }
  const corpusDir = args.corpusDir ?? DEFAULT_CORPUS_DIR;
  const judgmentDir = args.judgmentDir ?? DEFAULT_JUDGMENT_DIR;

  // The whole main body (not just the loading half): an uncaught exception
  // anywhere — shard I/O, the flip's mkdir/append — would exit 1 with a stack,
  // violating the 0/2 exit contract.
  try {
    const outcomes = loadOutcomeEntries(corpusDir);
    const jevRecords = loadJevCorpusRecords(corpusDir);
    const verdict = evaluateGate(outcomes, jevRecords);
    const corpusDigest = countedCorpusDigest(outcomes, jevRecords);
    // Read on every run, dry or flip: a broken chain is an operator emergency
    // that must refuse even a dry-run verdict (INV-ARM-1 fail-closed).
    const armState = readArmState(judgmentDir);

    if (!args.arm && !args.unarm) {
      process.stdout.write(`${JSON.stringify(verdict)}\n`);
      return 0;
    }

    // The flip: every gap collected, then ONE refusal before any write.
    const gaps: string[] = [];
    if (args.arm && verdict.verdict !== "eligible") {
      gaps.push(`gate verdict is ${verdict.verdict} — arming needs eligible:`, ...verdict.gaps.map((g) => `  ${g}`));
    }
    if (!args.signOff || args.signOff.trim().length === 0) {
      gaps.push("--sign-off \"<who when>\" is required — the DD-21 operator sign-off half of the pair");
    }
    if (process.env.QDS_JUDGMENT_ARM_CONFIRMED !== "1") {
      gaps.push("env QDS_JUDGMENT_ARM_CONFIRMED=1 is required — the second half of the sign-off pair");
    }
    if (args.arm && armState.state === "armed") gaps.push(`already armed (head seq ${armState.lastSeq}) — the log head IS the state`);
    if (args.unarm && armState.state === "recording-only") gaps.push(`already recording-only (head seq ${armState.lastSeq}) — nothing to unarm`);
    if (gaps.length > 0) exitWithFailure("arm-thresholds: refusing the flip, nothing written:", 2, gaps);

    // Fixed literal key order = the canonical serialization the digest chains.
    const entry: ArmStateEntry = {
      seq: armState.lastSeq + 1,
      at: new Date().toISOString(),
      from: armState.state,
      to: args.arm ? "armed" : "recording-only",
      sign_off: args.signOff!,
      evidence: {
        confirmed: verdict.milestones.confirmed,
        agreed: verdict.milestones.agreed,
        rate: verdict.milestones.rate,
        ci_lower: verdict.milestones.ci_lower,
        thresholds: thresholds(),
        corpus_digest: corpusDigest,
      },
      prev_digest: armState.headDigest,
    };
    mkdirSync(judgmentDir, { recursive: true });
    appendFileSync(join(judgmentDir, "arm-state.jsonl"), `${JSON.stringify(entry)}\n`);
    process.stdout.write(`${JSON.stringify(entry)}\n`);
    return 0;
  } catch (e) {
    exitWithFailure("arm-thresholds:", 2, [(e as Error).message]);
  }
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
