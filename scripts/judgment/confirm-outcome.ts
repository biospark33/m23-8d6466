#!/usr/bin/env bun
/**
 * CLI: append one operator-confirmed outcome entry to
 * `<corpus-dir>/outcomes.jsonl` (J2 AC5) — the honest in-repo outcome
 * population path the arm gate counts from.
 *
 *   bun scripts/judgment/confirm-outcome.ts --pr N --round N --finding-id S \
 *     --labeler S --outcome-confirmed <true|false> --outcome-source S \
 *     --answer-mode <live|mock> [--corpus-dir <dir>]
 *
 * `recordKey` (pr, round, finding_id, labeler) is the idempotence and
 * conflict authority: a second IDENTICAL entry is an idempotent no-op (no
 * duplicate row); a CONFLICTING entry refuses the append — exit 2 naming the
 * recordKey and both outcomes, appending nothing. Never first-write-wins:
 * the operator resolves a conflict by explicit action. `answer_mode`
 * attests, at confirm time, the mode of the judgment answer being confirmed;
 * mock-attested entries never enter the gate's counted population.
 *
 * shortcut: no run-lock around the read-test-append — one operator-run
 * append per invocation, like a flip; add one alongside merge's if confirms
 * ever become batched/automated.
 * Exit: 0 written or duplicate · 2 invalid input / conflict / malformed store.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { exitWithFailure, parseValueFlags, tokenizeArgs } from "../lib/cli-args.ts";
import { DEFAULT_CORPUS_DIR } from "../corpus/merge.ts";
import { OutcomeRecordSchema, recordKey, zodErrors, type OutcomeRecord } from "../corpus/schema.ts";

export interface ConfirmOutcomeArgs extends Omit<OutcomeRecord, "confirmed_at"> {
  corpusDir?: string;
}

const parsePositiveInt = (flag: string, raw: string): number => {
  // Strict decimal digits first: bare Number() admits "0x10", "1e2", and " 5".
  if (!/^\d+$/.test(raw)) throw new Error(`${flag} must be a positive decimal integer (digits only), got "${raw}"`);
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`${flag} must be a positive integer, got "${raw}"`);
  return n;
};

export function parseArgs(argv: string[]): ConfirmOutcomeArgs {
  let pr: number | undefined;
  let round: number | undefined;
  let findingId: string | undefined;
  let labeler: string | undefined;
  let outcomeConfirmed: boolean | undefined;
  let outcomeSource: string | undefined;
  let answerMode: "live" | "mock" | undefined;
  let corpusDir: string | undefined;
  const { flagTokens } = tokenizeArgs(argv, {
    valueFlags: ["--pr", "--round", "--finding-id", "--labeler", "--outcome-confirmed", "--outcome-source", "--answer-mode", "--corpus-dir"],
  });
  parseValueFlags(flagTokens, {
    flags: ["--pr", "--round", "--finding-id", "--labeler", "--outcome-confirmed", "--outcome-source", "--answer-mode", "--corpus-dir"],
    onValue: (flag, v) => {
      if (flag === "--pr") pr = parsePositiveInt(flag, v);
      else if (flag === "--round") round = parsePositiveInt(flag, v);
      else if (flag === "--finding-id") findingId = v;
      else if (flag === "--labeler") labeler = v;
      else if (flag === "--outcome-confirmed") {
        if (v !== "true" && v !== "false") throw new Error(`--outcome-confirmed must be "true" or "false", got "${v}"`);
        outcomeConfirmed = v === "true";
      } else if (flag === "--outcome-source") outcomeSource = v;
      else if (flag === "--answer-mode") {
        if (v !== "live" && v !== "mock") throw new Error(`--answer-mode must be "live" or "mock", got "${v}"`);
        answerMode = v;
      } else corpusDir = v;
    },
    help: [
      "Usage: confirm-outcome --pr N --round N --finding-id S --labeler S \\",
      "                 --outcome-confirmed <true|false> --outcome-source S \\",
      "                 --answer-mode <live|mock> [--corpus-dir <dir>]",
      "",
      "Appends one operator-confirmed outcome entry to outcomes.jsonl, joined",
      "to jev-arm corpus records by recordKey. Identical re-confirm: no-op.",
      "Conflicting recordKey: refuses, naming the key and both outcomes.",
      "",
      "Exit: 0 written or duplicate · 2 invalid input / conflict / malformed store",
      "",
    ],
  });
  const missing = (
    [
      ["--pr", pr],
      ["--round", round],
      ["--finding-id", findingId],
      ["--labeler", labeler],
      ["--outcome-confirmed", outcomeConfirmed],
      ["--outcome-source", outcomeSource],
      ["--answer-mode", answerMode],
    ] as const
  )
    .filter(([, v]) => v === undefined)
    .map(([f]) => f);
  if (missing.length > 0) throw new Error(`missing required flags: ${missing.join(" ")}`);
  return {
    pr: pr!,
    round: round!,
    finding_id: findingId!,
    labeler: labeler!,
    outcome_confirmed: outcomeConfirmed!,
    outcome_source: outcomeSource!,
    answer_mode: answerMode!,
    corpusDir,
  };
}

/** Existing entries of outcomes.jsonl; absent file = []; a malformed line is a loud error (a torn write is an operator fact). */
export function readOutcomeEntries(file: string): OutcomeRecord[] {
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
      if (!parsed.success) throw new Error(`outcomes.jsonl line ${i + 1} failed OutcomeRecordSchema validation: ${zodErrors(parsed.error).join("; ")}`);
      return parsed.data;
    });
}

export async function main(argv: string[]): Promise<number> {
  let args: ConfirmOutcomeArgs;
  try {
    args = parseArgs(argv);
  } catch (e) {
    exitWithFailure("confirm-outcome:", 2, [(e as Error).message]);
  }

  // The whole main body (not just the read half): an uncaught exception
  // anywhere — store I/O, the append itself — would exit 1 with a stack,
  // violating the 0/2 exit contract.
  try {
    const { corpusDir, ...fields } = args;
    const dir = corpusDir ?? DEFAULT_CORPUS_DIR;
    const file = join(dir, "outcomes.jsonl");

    // confirmed_at attests at confirm time (parse re-stamps it).
    const incoming = OutcomeRecordSchema.parse({ ...fields, confirmed_at: new Date().toISOString() });
    const existing = readOutcomeEntries(file);

    const key = recordKey(incoming);
    const prior = existing.filter((e) => recordKey(e) === key);
    if (prior.length > 0) {
      // Identity = the three outcome fields (confirmed_at attests each event, so
      // a re-confirm carries a new timestamp and is still the same outcome).
      const identical = prior.every(
        (p) => p.outcome_confirmed === incoming.outcome_confirmed && p.outcome_source === incoming.outcome_source && p.answer_mode === incoming.answer_mode,
      );
      if (!identical) {
        const p = prior[0]!;
        exitWithFailure("confirm-outcome: conflicting outcome for an existing recordKey — refusing the append (never first-write-wins; resolve explicitly):", 2, [
          `recordKey ${key}`,
          `existing: outcome_confirmed=${p.outcome_confirmed} outcome_source=${p.outcome_source} answer_mode=${p.answer_mode} confirmed_at=${p.confirmed_at}`,
          `incoming: outcome_confirmed=${incoming.outcome_confirmed} outcome_source=${incoming.outcome_source} answer_mode=${incoming.answer_mode}`,
        ]);
      }
      process.stdout.write(`${JSON.stringify({ status: "duplicate", recordKey: key })}\n`);
      return 0;
    }

    mkdirSync(dir, { recursive: true });
    appendFileSync(file, `${JSON.stringify(incoming)}\n`);
    process.stdout.write(`${JSON.stringify({ status: "written", recordKey: key, record: incoming })}\n`);
    return 0;
  } catch (e) {
    exitWithFailure("confirm-outcome:", 2, [(e as Error).message]);
  }
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
