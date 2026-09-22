#!/usr/bin/env bun
/**
 * CLI: validate a skill sidecar (`triage.json`) against the corpus schema.
 *
 *   bun scripts/corpus/validate.ts <triage.json>
 *
 * Exit codes only, per the trigger surface: 0 valid, 2 invalid — with the
 * exact field/zod path named on stderr and nothing written anywhere.
 */

import { readFileSync } from "node:fs";
import { exitWithFailure, parseValueFlags, tokenizeArgs } from "../lib/cli-args.ts";
import { TriageSidecarSchema, zodErrors, type TriageSidecar } from "./schema.ts";

export function parseArgs(argv: string[]): { path: string } {
  const { positionals, flagTokens } = tokenizeArgs(argv, { valueFlags: [], rejectStraySingleDash: true });
  // No value flags exist here, so parseValueFlags is the unknown-flag/--help gate.
  parseValueFlags(flagTokens, {
    flags: [],
    onValue: () => {},
    help: [
      "Usage: validate.ts <triage.json>",
      "",
      "Validates a skill sidecar against the corpus schema. Exit 0 valid, 2 invalid",
      "(the exact field/zod path is named on stderr). Writes nothing.",
      "",
    ],
  });
  if (positionals.length !== 1) {
    throw new Error("usage: validate.ts <triage.json> — exactly one sidecar path");
  }
  return { path: positionals[0]! };
}

/** The schema gate shared with `merge.ts`: named-field errors, never a stack dump. */
export function validateSidecarText(text: string): { ok: true; sidecar: TriageSidecar } | { ok: false; errors: string[] } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { ok: false, errors: [`(root): invalid JSON — ${(e as Error).message}`] };
  }
  const parsed = TriageSidecarSchema.safeParse(raw);
  return parsed.success ? { ok: true, sidecar: parsed.data } : { ok: false, errors: zodErrors(parsed.error) };
}

export async function main(argv: string[]): Promise<number> {
  try {
    const { path } = parseArgs(argv);
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch (e) {
      exitWithFailure("corpus-validate:", 2, [`cannot read ${path}: ${(e as Error).message}`]);
    }
    const result = validateSidecarText(text);
    if (!result.ok) {
      exitWithFailure(`corpus-validate: ${path} is NOT a valid triage sidecar`, 2, result.errors);
    }
    process.stdout.write(
      `corpus-validate: ${path} OK (${result.sidecar.findings.length} findings, pr=${result.sidecar.pr}, round=${result.sidecar.round})\n`,
    );
    return 0;
  } catch (e) {
    exitWithFailure("corpus-validate:", 2, [(e as Error).message]);
  }
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
