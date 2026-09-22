#!/usr/bin/env bun
/**
 * CLI: the S1 Jev observer (JEV-3, handoff §7 Wave 3) — pre-routes the
 * findings of one triage round through the TypeSafe judgment client and
 * records the answers as paired corpus records.
 *
 *   bun scripts/judgment/observe-round.ts --pr <n> --round <n>
 *       [--corpus-dir <dir>] [--out <dir>] [--provenance-dir <dir>]
 *       [--ceiling-tokens <n>]
 *
 * For each `arm="frontier"` record in `<corpus-dir>/<pr>-r<round>.jsonl` the
 * observer builds a SMALL state (the lead-authored finding_text + the
 * diff_context_ref pointer + pr/round/finding_id — NEVER a diff hunk, NEVER
 * bot prose, never the frontier's own verdict), asks exactly TWO questions —
 * `is_real_defect` (noul) and `disposition` (choice over patch/dismiss/
 * gate-action, LOCKED §3.9) — and appends one schema'd record with
 * `labeler: jev-1.13.0-observer`, `arm: jev` through the JEV-1 corpus
 * barrel. Idempotent on (pr, round, finding_id, labeler): re-running a round
 * re-judges but appends nothing new.
 *
 * Modes: the client is constructed with NO mode option, so its normal
 * resolution applies — default mock; TYPESAFE_MOCK=1 forces mock. This CLI
 * has no path to live mode at all: reaching the wire requires a code change
 * (passing `mode: "live"`), a key, and steve's explicit go in chat (INV-J5).
 *
 * Recording-only (§3.5): no threshold, no routing decision, no gate
 * authority. Nothing else in the repo reads this output until Wave 4's
 * measurement harness.
 */

import { existsSync, mkdirSync } from "node:fs";
import { exitWithFailure, parseValueFlags, tokenizeArgs } from "../lib/cli-args.ts";
import { acquireRunLock, releaseRunLock } from "../lib/run-lock.ts";
import { CORPUS_LOCK_ID, DEFAULT_CORPUS_DIR, appendRecord, corpusFilePath, readRecords } from "../corpus/merge.ts";
import { TriageRecordSchema, type Disposition, type TriageRecord } from "../corpus/schema.ts";
import {
  CeilingExceededError,
  DEFAULT_STAGE_CEILING_INPUT_TOKENS,
  DEFAULT_WARN_STATE_CHARS,
  JudgmentCeiling,
  JudgmentClient,
  type JudgmentEnvelope,
  type Question,
} from "../../src/judgment/index.ts";

/** The observer's provenance class — lead-authored finding text, stage-1 legal (ADR 0001). */
export const OBSERVER_EGRESS_CLASS = "finding-text" as const;
/** Per JEV-1's Wave-3 seam: the jev-arm labeler identity. */
export const JEV_LABELER = "jev-1.13.0-observer";

/**
 * The two LOCKED questions (§3.9) — nothing else is asked. No severity
 * question (the frontier session owns severity), no score, no generation.
 * Criteria keys are the ONLY reachable enum values: choice maps
 * {patch→PATCH, dismiss→DISMISS, gate-action→GATE_ACTION}.
 */
export const OBSERVER_QUESTIONS = {
  is_real_defect: {
    type: "noul",
    instructions:
      "Judge ONLY the finding stated in the state against its diff_context_ref: is it a real defect — a genuine bug, vulnerability, or broken contract in the code described? Style preferences, hypothetical scenarios, and code that already behaves correctly are not real defects.",
  },
  disposition: {
    type: "choice",
    instructions: "If this finding were accepted, what should happen next to it in this review round?",
    criteria: {
      patch: "fix it within this change before merge",
      dismiss: "not actionable — close it without a fix",
      "gate-action": "hold the merge pending a decision or action outside this change",
    },
  },
} as const satisfies Record<string, Question>;

const DISPOSITION_BY_CHOICE: Record<string, Disposition> = {
  patch: "PATCH",
  dismiss: "DISMISS",
  "gate-action": "GATE_ACTION",
};

export interface ObserveArgs {
  pr: number;
  round: number;
  corpusDir?: string;
  out?: string;
  provenanceDir?: string;
  ceilingTokens?: number;
}

export function parseArgs(argv: string[]): ObserveArgs {
  let pr: number | undefined;
  let round: number | undefined;
  let corpusDir: string | undefined;
  let out: string | undefined;
  let provenanceDir: string | undefined;
  let ceilingTokens: number | undefined;
  const flags = ["--pr", "--round", "--corpus-dir", "--out", "--provenance-dir", "--ceiling-tokens"] as const;
  const { flagTokens } = tokenizeArgs(argv, { valueFlags: [...flags] });
  parseValueFlags(flagTokens, {
    flags,
    onValue: (flag, v) => {
      if (flag === "--pr") pr = Number(v);
      else if (flag === "--round") round = Number(v);
      else if (flag === "--corpus-dir") corpusDir = v;
      else if (flag === "--out") out = v;
      else if (flag === "--provenance-dir") provenanceDir = v;
      else ceilingTokens = Number(v);
    },
    help: [
      "Usage: observe-round --pr <n> --round <n> [--corpus-dir <dir>] [--out <dir>] [--provenance-dir <dir>] [--ceiling-tokens <n>]",
      "",
      "Records paired jev-arm corpus records for every frontier finding of the",
      "named triage round. Recording-only: no threshold, no routing, no gate.",
      "Idempotent per (pr, round, finding_id, labeler=jev-1.13.0-observer).",
      "",
      "Exit: 0 recorded · 2 no frontier records / ceiling refused / bad answer",
      "",
    ],
  });
  for (const [name, v] of [
    ["--pr", pr],
    ["--round", round],
  ] as const) {
    if (v === undefined) throw new Error(`${name} <positive integer> is required`);
    if (!Number.isInteger(v) || v <= 0) throw new Error(`${name} must be a positive integer, got ${v}`);
  }
  if (ceilingTokens !== undefined && (!Number.isInteger(ceilingTokens) || ceilingTokens <= 0)) {
    throw new Error(`--ceiling-tokens must be a positive integer, got ${ceilingTokens}`);
  }
  return { pr: pr as number, round: round as number, corpusDir, out, provenanceDir, ceilingTokens };
}

/**
 * The judged state for ONE finding — deliberately tiny (the vendor budget is
 * 32k tokens for state + longest question). The frontier label and
 * disposition are EXCLUDED on purpose: shipping the lead's verdict would leak
 * the answer into the judged arm and fake the agreement metric.
 */
export function buildState(f: TriageRecord, pr: number, round: number): Record<string, unknown> {
  return {
    pr,
    round,
    finding_id: f.finding_id,
    finding_text: f.finding_text,
    diff_context_ref: f.diff_context_ref,
  };
}

/** choice answer → corpus enum. An off-criteria answer is refused, never guessed. */
export function dispositionFromChoice(choice: string): Disposition {
  const mapped = DISPOSITION_BY_CHOICE[choice];
  if (mapped === undefined) {
    throw new Error(`jev disposition answer "${choice}" is not one of the asked criteria (patch|dismiss|gate-action) — refusing to guess the enum value`);
  }
  return mapped;
}

/**
 * The record rationale, computed in code from the envelope: the noul verdict
 * verbatim, plus the chosen criterion and its probability — probabilities are
 * numbers from the answer payload, never model arithmetic.
 */
export function rationaleFrom(envelope: JudgmentEnvelope): string {
  const noul = envelope.answers.is_real_defect;
  const disp = envelope.answers.disposition;
  if (!noul || noul.type !== "noul") {
    throw new Error(`envelope is missing a noul answer for "is_real_defect"`);
  }
  if (!disp || disp.type !== "choice") {
    throw new Error(`envelope is missing a choice answer for "disposition"`);
  }
  const p = disp.probabilities[disp.choice];
  const pClause = typeof p === "number" && Number.isFinite(p) ? ` p=${p}` : "";
  return `jev: is_real_defect=${noul.noul}; disposition=${disp.choice}${pClause}`;
}

/**
 * Project one judged finding into a corpus record. Severity stays with the
 * lead (the frontier `label` is copied); latency and exact cost derive from
 * the envelope in code (input-token-only billing at $0.042/Mtok);
 * `created_at` is the envelope's merge-time stamp — JEV-1's
 * best-available-timestamp-wins rule with the judge moment as the stamp.
 */
export function recordFrom(frontier: TriageRecord, envelope: JudgmentEnvelope, pr: number, round: number): TriageRecord {
  const disp = envelope.answers.disposition;
  if (!disp || disp.type !== "choice") {
    throw new Error(`envelope is missing a choice answer for "disposition"`);
  }
  return TriageRecordSchema.parse({
    finding_id: frontier.finding_id,
    finding_text: frontier.finding_text,
    diff_context_ref: frontier.diff_context_ref,
    label: frontier.label,
    disposition: dispositionFromChoice(disp.choice),
    rationale: rationaleFrom(envelope),
    labeler: JEV_LABELER,
    pr,
    round,
    created_at: envelope.created_at,
    arm: "jev",
    latency_ms: envelope.latency_ms,
    cost_exact_usd: (envelope.usage.input_tokens * 0.042) / 1_000_000,
  });
}

export interface ObserveOptions {
  pr: number;
  round: number;
  /** Frontier records read here (default: JEV-1's corpus dir). */
  corpusDir?: string;
  /** Jev records append here (default: same file as corpusDir — both arms coexist). */
  outDir?: string;
  /** Tests MUST override — the client's default is the real provenance dir. */
  provenanceDir?: string;
  ceilingTokens?: number;
}

export interface ObserveResult {
  recordsFile: string;
  frontierFindings: number;
  judged: number;
  written: number;
  duplicateSkipped: number;
  /** Set when the stage ceiling refused mid-round — the judged prefix stays. */
  refused: { findingId: string; reason: string; unjudged: string[] } | null;
  ceilingObserved: number;
  ceilingLimit: number;
}

/**
 * Observe one triage round. States are sized and refused PRE-FLIGHT (a
 * mega-state can never leave a partial append); judgments run one call per
 * finding through the client's normal mode resolution; appends run under the
 * shared corpus run-lock, so a mid-round ceiling refusal leaves exactly the
 * judged prefix recorded — reported in the result, never silent.
 */
export async function observeRound(opts: ObserveOptions): Promise<ObserveResult> {
  const corpusDir = opts.corpusDir ?? DEFAULT_CORPUS_DIR;
  const outDir = opts.outDir ?? corpusDir;
  const frontierFile = corpusFilePath(corpusDir, opts.pr, opts.round);
  if (!existsSync(frontierFile)) {
    throw new Error(
      `no frontier corpus records for pr=${opts.pr} round=${opts.round}: expected ${frontierFile} — merge the lead's triage sidecar first (scripts/corpus/merge.ts)`,
    );
  }
  const frontier = readRecords(frontierFile).filter((r) => r.arm === "frontier");
  if (frontier.length === 0) {
    throw new Error(`${frontierFile} carries no arm="frontier" records — nothing to pair against`);
  }
  // Pre-flight small-state budget (§4: 32k tokens for state + longest
  // question). The client only warns past ~100k chars; the observer refuses,
  // before any judgment, naming the finding.
  for (const f of frontier) {
    const chars = JSON.stringify(buildState(f, opts.pr, opts.round)).length;
    if (chars > DEFAULT_WARN_STATE_CHARS) {
      throw new Error(
        `finding ${f.finding_id} state is ${chars} chars — over the ${DEFAULT_WARN_STATE_CHARS}-char small-state budget; refusing to ship a mega-state (split or trim the finding text)`,
      );
    }
  }

  mkdirSync(outDir, { recursive: true });
  const ceiling = new JudgmentCeiling(opts.ceilingTokens ?? DEFAULT_STAGE_CEILING_INPUT_TOKENS);
  // NO mode option: default mock; TYPESAFE_MOCK=1 forces mock. Live is
  // unreachable from here without a code change + key + steve's go (INV-J5).
  const client = new JudgmentClient({ provenanceDir: opts.provenanceDir });
  const result: ObserveResult = {
    recordsFile: corpusFilePath(outDir, opts.pr, opts.round),
    frontierFindings: frontier.length,
    judged: 0,
    written: 0,
    duplicateSkipped: 0,
    refused: null,
    ceilingObserved: 0,
    ceilingLimit: ceiling.ceiling,
  };

  const lock = acquireRunLock(outDir, CORPUS_LOCK_ID, "jev observe");
  try {
    for (const [i, f] of frontier.entries()) {
      let envelope: JudgmentEnvelope;
      try {
        envelope = await client.judge(buildState(f, opts.pr, opts.round), OBSERVER_QUESTIONS, {
          egressClass: OBSERVER_EGRESS_CLASS,
          ceiling,
        });
      } catch (e) {
        if (e instanceof CeilingExceededError) {
          result.ceilingObserved = ceiling.observedInputTokens;
          result.refused = {
            findingId: f.finding_id,
            reason: e.message,
            unjudged: frontier.slice(i).map((x) => x.finding_id),
          };
          return result; // finally releases the lock; the judged prefix stays appended
        }
        throw e;
      }
      result.judged++;
      if (appendRecord(outDir, recordFrom(f, envelope, opts.pr, opts.round)) === "written") result.written++;
      else result.duplicateSkipped++;
    }
  } finally {
    releaseRunLock(lock);
  }
  result.ceilingObserved = ceiling.observedInputTokens;
  return result;
}

export async function main(argv: string[]): Promise<number> {
  try {
    const args = parseArgs(argv);
    const result = await observeRound(args);
    process.stdout.write(
      `jev-observe: ${result.recordsFile}: ${result.frontierFindings} frontier findings, ${result.judged} judged, ` +
        `${result.written} written, ${result.duplicateSkipped} duplicate-skipped, ` +
        `ceiling ${result.ceilingObserved}/${result.ceilingLimit} input tokens\n`,
    );
    process.stdout.write(
      "jev-observe: recording-only — no threshold, no routing, no gate authority (handoff §3.5); labeler jev-1.13.0-observer, arm jev\n",
    );
    if (result.refused) {
      exitWithFailure("jev-observe: stage ceiling exceeded mid-round", 2, [
        `refused finding ${result.refused.findingId}: ${result.refused.reason}`,
        `already-recorded judgments were kept (${result.written} written, ${result.duplicateSkipped} duplicate-skipped); unjudged findings: ${result.refused.unjudged.join(", ")}`,
      ]);
    }
    return 0;
  } catch (e) {
    exitWithFailure("jev-observe:", 2, [(e as Error).message]);
  }
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
