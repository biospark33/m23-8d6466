#!/usr/bin/env bun
/**
 * CLI: merge a skill-written `<workdir>/triage.json` sidecar into corpus records.
 *
 *   bun scripts/corpus/merge.ts --workdir <dir> [--out <corpus dir>]
 *
 * One JSONL record per finding lands at `<out>/<pr>-r<round>.jsonl`
 * (default out: `_bmad-output/judgment/corpus/`). Idempotent on
 * `(pr, round, finding_id, labeler)`: re-running the same merge appends
 * nothing. The read-test-append runs under `scripts/lib/run-lock.ts` so two
 * cold-path invocations cannot interleave appends.
 *
 * Stamp rules (best-available-timestamp-wins): a sidecar-supplied
 * `created_at`/`latency_ms` is preserved; otherwise `created_at` is stamped at
 * merge time and `latency_ms` is null. A top-level `duration_ms` times the
 * `QDS_FRONTIER_USD_PER_MS` env rate becomes `cost_estimate_usd` — an estimate
 * by name, never metered; without either input the field stays honestly null.
 *
 * HONEST LIMITATION: merge validates SHAPE, not authorship. `finding_text`
 * provenance is the skill edit's contract (Appendix A of the story); no
 * bot-prose sniffing happens here. Exit codes: 0 merged, 2 invalid input.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { z } from "zod";
import { exitWithFailure, parseValueFlags, tokenizeArgs } from "../lib/cli-args.ts";
import { acquireRunLock, releaseRunLock } from "../lib/run-lock.ts";
import {
  CorpusRecordSchema,
  MachineStateRecordSchema,
  TriageRecordSchema,
  TriageSidecarSchema,
  recordKey,
  zodErrors,
  type CorpusRecord,
  type TriageRecord,
  type TriageSidecar,
} from "./schema.ts";

/** Forward labeler — the triage lead identity (the sidecar carries none). */
export const DEFAULT_LABELER = "frontier-lead";
export const DEFAULT_CORPUS_DIR = "_bmad-output/judgment/corpus";
/** Machine-state (L7) records live in their own dir so triage files never contain them. */
export const DEFAULT_MACHINE_STATE_CORPUS_DIR = "_bmad-output/judgment/corpus/machine-state";
/** Single-writer discipline: both corpus writers share one lock id. */
export const CORPUS_LOCK_ID = "corpus-writer";

export interface MergeArgs {
  workdir: string;
  out?: string;
}

export function parseArgs(argv: string[]): MergeArgs {
  let workdir: string | undefined;
  let outDir: string | undefined;
  const { flagTokens } = tokenizeArgs(argv, { valueFlags: ["--workdir", "--out"] });
  parseValueFlags(flagTokens, {
    flags: ["--workdir", "--out"],
    onValue: (flag, v) => {
      if (flag === "--workdir") workdir = v;
      else outDir = v;
    },
    help: [
      "Usage: merge --workdir <dir> [--out <corpus dir>]",
      "",
      "Merges <dir>/triage.json (the skill's sidecar) into one JSONL record per",
      "finding at <out>/<pr>-r<round>.jsonl. Idempotent per (pr, round, finding_id, labeler).",
      "",
      "Exit: 0 merged · 2 invalid sidecar or missing workdir",
      "",
    ],
  });
  if (workdir === undefined) throw new Error("--workdir <dir> is required (the directory holding the skill's triage.json)");
  return { workdir, out: outDir };
}

/** The frontier rate steve calibrates; absent/invalid env means "no estimate available". */
export function frontierRateUsdPerMs(): number | null {
  const raw = process.env.QDS_FRONTIER_USD_PER_MS;
  if (raw === undefined || raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** `<pr>-r<round>.jsonl`; `x` marks a part the record honestly does not carry (backfill only). */
export function corpusFilePath(outDir: string, pr: number | null, round: number | null): string {
  return join(outDir, `${pr ?? "x"}-r${round ?? "x"}.jsonl`);
}

export interface ProjectOptions {
  /** Merge time for findings the sidecar did not timestamp. Defaults to now. */
  now?: string;
  /** USD per millisecond; null leaves `cost_estimate_usd` null. */
  rateUsdPerMs?: number | null;
  labeler?: string;
}

/**
 * Project a validated sidecar into records — the ONLY place `created_at`,
 * `labeler` and the cost estimate are stamped, so the record schema stays the
 * authority and the sidecar its input projection.
 */
export function sidecarToRecords(sidecar: TriageSidecar, opts: ProjectOptions = {}): TriageRecord[] {
  const now = opts.now ?? new Date().toISOString();
  const labeler = opts.labeler ?? DEFAULT_LABELER;
  const rate = opts.rateUsdPerMs ?? null;
  const estimate = sidecar.duration_ms !== undefined && rate !== null ? sidecar.duration_ms * rate : null;
  return sidecar.findings.map((f) =>
    TriageRecordSchema.parse({
      finding_id: f.finding_id,
      finding_text: f.finding_text,
      diff_context_ref: f.diff_context_ref,
      label: f.label,
      disposition: f.disposition,
      ...(f.rationale !== undefined ? { rationale: f.rationale } : {}),
      labeler,
      pr: sidecar.pr,
      round: sidecar.round,
      created_at: f.created_at ?? now,
      arm: "frontier",
      latency_ms: f.latency_ms ?? null,
      cost_estimate_usd: estimate,
    }),
  );
}

/** Parse every non-blank line of one JSONL file; a malformed line fails loudly (a torn write is an operator fact). */
function readLines<T>(file: string, schema: { safeParse(v: unknown): { success: true; data: T } | { success: false; error: z.ZodError } }): T[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l, i) => {
      const parsed = schema.safeParse(JSON.parse(l));
      if (!parsed.success) {
        throw new Error(`corpus file ${file} line ${i + 1} failed schema validation: ${zodErrors(parsed.error).join("; ")}`);
      }
      return parsed.data;
    });
}

/** Existing triage records of one JSONL corpus file (ab-report's contract; machine-state lines are a loud error here). */
export function readRecords(file: string): TriageRecord[] {
  return readLines(file, TriageRecordSchema);
}

/** Existing records of either arm — what `appendRecord`'s dedupe reads. */
export function readCorpusRecords(file: string): CorpusRecord[] {
  return readLines(file, CorpusRecordSchema);
}

/** Shared validate -> dedupe -> append; `schema` decides which arm this file may hold (a foreign line fails loudly). */
function appendValidated<T extends { pr: number | null; round: number | null; finding_id: string; labeler: string }>(
  outDir: string,
  record: unknown,
  schema: { safeParse(v: unknown): { success: true; data: T } | { success: false; error: z.ZodError } },
): "written" | "duplicate" {
  const parsed = schema.safeParse(record);
  if (!parsed.success) {
    throw new Error(`record failed schema validation: ${zodErrors(parsed.error).join("; ")}`);
  }
  const r = parsed.data;
  const file = corpusFilePath(outDir, r.pr, r.round);
  const key = recordKey(r);
  if (readLines(file, schema).some((existing) => recordKey(existing) === key)) return "duplicate";
  appendFileSync(file, `${JSON.stringify(r)}\n`);
  return "written";
}

/**
 * The Wave-3 observer's entry point: schema-validate then append one TRIAGE record.
 * Callers hold the corpus run-lock around their batch of these — the lock owns
 * the read-test-append discipline, this owns validation and the append itself.
 * Triage-only: a machine-state record is refused (use `appendMachineStateRecord`).
 */
export function appendRecord(outDir: string, record: unknown): "written" | "duplicate" {
  return appendValidated(outDir, record, TriageRecordSchema);
}

/** Machine-state (L7) twin of `appendRecord`; same lock discipline, caller creates `outDir`. Triage records are refused. */
export function appendMachineStateRecord(outDir: string, record: unknown): "written" | "duplicate" {
  return appendValidated(outDir, record, MachineStateRecordSchema);
}

export async function main(argv: string[]): Promise<number> {
  try {
    const args = parseArgs(argv);
    const sidecarPath = join(args.workdir, "triage.json");
    if (!existsSync(sidecarPath)) {
      exitWithFailure("corpus-merge:", 2, [
        `no sidecar at ${sidecarPath}`,
        "the input contract is the skill's step-03 Write — Appendix A of _bmad-output/typesafe-integration/stories/jev-1-corpus-capture.md",
      ]);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(sidecarPath, "utf8"));
    } catch (e) {
      exitWithFailure(`corpus-merge: ${sidecarPath} is not valid JSON`, 2, [(e as Error).message]);
    }
    const sidecar = TriageSidecarSchema.safeParse(raw);
    if (!sidecar.success) {
      exitWithFailure(`corpus-merge: ${sidecarPath} failed sidecar validation (strict — unknown keys are errors)`, 2, zodErrors(sidecar.error));
    }
    const outDir = args.out ?? DEFAULT_CORPUS_DIR;
    mkdirSync(outDir, { recursive: true });
    const records = sidecarToRecords(sidecar.data, { rateUsdPerMs: frontierRateUsdPerMs() });
    const lock = acquireRunLock(outDir, CORPUS_LOCK_ID, "corpus merge");
    let written = 0;
    let duplicates = 0;
    try {
      for (const r of records) {
        if (appendRecord(outDir, r) === "written") written++;
        else duplicates++;
      }
    } finally {
      releaseRunLock(lock);
    }
    process.stdout.write(
      `corpus-merge: ${sidecarPath} -> ${corpusFilePath(outDir, sidecar.data.pr, sidecar.data.round)}: ` +
        `${records.length} findings, ${written} written, ${duplicates} duplicate-skipped\n`,
    );
    process.stdout.write(
      "corpus-merge: shape validated only — finding_text provenance is the skill edit's contract (Appendix A); no authorship sniffing is performed\n",
    );
    return 0;
  } catch (e) {
    exitWithFailure("corpus-merge:", 2, [(e as Error).message]);
  }
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
