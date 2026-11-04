#!/usr/bin/env bun
/**
 * CLI: the J2 armed routing surface (AC4) — partitions ONE round's corpus
 * records by their RECORDED jev answers into `deep-adjudication` vs
 * `obvious-dismiss-candidate` and writes `<judgment-dir>/routing/N-R.json`.
 *
 *   bun scripts/judgment/route-round.ts --pr N --round N [--corpus-dir <dir>] [--judgment-dir <dir>]
 *
 * Refuses exit 2 `not-armed` BEFORE ANY WRITE unless the arm-state log's head
 * is a chain-valid armed entry (INV-ARM-1 fail-closed): absent/empty log,
 * broken chain, or a recording-only head all refuse. Routes from recorded
 * answers only — no live judgment call exists here (AC4 negative control);
 * the manifest is an input, nothing auto-dismisses, and the frontier session
 * stays authoritative (LOCKED #10).
 * Exit: 0 manifest written + one-line summary · 2 fatal before any conclusion.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { exitWithFailure, parseValueFlags, tokenizeArgs } from "../lib/cli-args.ts";
import { DEFAULT_CORPUS_DIR, corpusFilePath, readRecords } from "../corpus/merge.ts";
import type { TriageRecord } from "../corpus/schema.ts";
import { MIN_ROUTE_CONFIDENCE, verifyArmStateLog } from "../../src/judgment/arm-gate.ts";

const DEFAULT_JUDGMENT_DIR = "_bmad-output/judgment";

export interface RouteRoundArgs {
  pr: number;
  round: number;
  corpusDir?: string;
  judgmentDir?: string;
}

export function parseArgs(argv: string[]): RouteRoundArgs {
  let pr: number | undefined;
  let round: number | undefined;
  let corpusDir: string | undefined;
  let judgmentDir: string | undefined;
  const { flagTokens } = tokenizeArgs(argv, {
    valueFlags: ["--pr", "--round", "--corpus-dir", "--judgment-dir"],
  });
  parseValueFlags(flagTokens, {
    flags: ["--pr", "--round", "--corpus-dir", "--judgment-dir"],
    onValue: (flag, v) => {
      if (flag === "--pr") pr = Number(v);
      else if (flag === "--round") round = Number(v);
      else if (flag === "--corpus-dir") corpusDir = v;
      else judgmentDir = v;
    },
    help: [
      "Usage: route-round --pr N --round N [--corpus-dir <dir>] [--judgment-dir <dir>]",
      "",
      "Writes <judgment-dir>/routing/N-R.json partitioning the round's records",
      "by their recorded jev answers: disposition DISMISS AND clause",
      "disposition=dismiss p>=MIN_ROUTE_CONFIDENCE (src/judgment/arm-gate.ts,",
      "in code) → obvious-dismiss-candidate; everything else, including",
      "records without a jev answer, → deep-adjudication. Refuses exit 2",
      "not-armed unless the arm-state head is chain-valid armed.",
      "",
      "Exit: 0 manifest written + one-line summary · 2 fatal before any conclusion",
      "",
    ],
  });
  for (const [name, v] of [["--pr", pr], ["--round", round]] as const) {
    if (!Number.isInteger(v) || (v as number) <= 0) throw new Error(`${name} <N> is required (a positive integer)`);
  }
  return { pr: pr!, round: round!, corpusDir, judgmentDir };
}

// ---------------------------------------------------------------------------
// The armed gate (fail-closed: the chain IS the authority)
// ---------------------------------------------------------------------------

/**
 * The digest of the armed head the routing runs under — or exit 2 before any
 * write. Absent/empty log, a tampered chain, or a recording-only head all
 * refuse: an empty log is not a chain, and routing under anything but a
 * verified armed head is unauthorized influence.
 */
function armedHeadDigest(judgmentDir: string): string {
  const file = join(judgmentDir, "arm-state.jsonl");
  const lines = existsSync(file) ? readFileSync(file, "utf8").split("\n").filter((l) => l.trim() !== "") : [];
  if (lines.length === 0) {
    exitWithFailure("route-round: not-armed:", 2, [
      `arm-state log absent or empty at ${file} — absent or empty means recording-only, never armed`,
    ]);
  }
  const v = verifyArmStateLog(lines);
  if (!v.ok) {
    exitWithFailure("route-round: not-armed:", 2, [
      `arm-state.jsonl fails chain verification — a broken chain is never honored: ${v.reason}`,
    ]);
  }
  if (v.head.to !== "armed") {
    exitWithFailure("route-round: not-armed:", 2, [
      `arm-state head (seq ${v.head.seq}) is "${v.head.to}" — routing needs an armed head`,
    ]);
  }
  return v.headDigest;
}

// ---------------------------------------------------------------------------
// The recorded-clause reader + partition (AC4)
// ---------------------------------------------------------------------------

/**
 * The recorded jev clause, mirroring parseIsRealDefect (ab-report.ts): regex
 * over the recorded rationale, never a re-judge. Absent clause =
 * "not-recorded" (never guessed).
 */
export function parseDispositionProbability(rationale: string | undefined): { disposition: string; p: number } | "not-recorded" {
  const m = rationale?.match(/jev:.*disposition=([a-z_]+) p=([0-9]+(?:\.[0-9]+)?)/);
  return m ? { disposition: m[1]!, p: Number.parseFloat(m[2]!) } : "not-recorded";
}

export interface RoutingEntry {
  finding_id: string;
  rationale: string;
  armed_state_digest: string;
}

export interface RoutingManifest {
  pr: number;
  round: number;
  armed_digest: string;
  deep_adjudication: RoutingEntry[];
  obvious_dismiss_candidates: RoutingEntry[];
}

/**
 * The ONE narrow lane: a recorded DISMISS whose own clause says dismiss at
 * p >= MIN_ROUTE_CONFIDENCE. Everything else — other dispositions,
 * sub-threshold or absent clauses, records without a jev answer — goes
 * deep-adjudication (never guessed).
 */
function partition(records: TriageRecord[], digest: string): { deep: RoutingEntry[]; candidates: RoutingEntry[] } {
  const deep: RoutingEntry[] = [];
  const candidates: RoutingEntry[] = [];
  for (const r of records) {
    const clause = parseDispositionProbability(r.rationale);
    const obvious =
      r.arm === "jev" &&
      r.disposition === "DISMISS" &&
      clause !== "not-recorded" &&
      clause.disposition.toLowerCase() === "dismiss" &&
      clause.p >= MIN_ROUTE_CONFIDENCE;
    const entry: RoutingEntry = { finding_id: r.finding_id, rationale: r.rationale ?? "", armed_state_digest: digest };
    (obvious ? candidates : deep).push(entry);
  }
  return { deep, candidates };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export function main(argv: string[]): number {
  let args: RouteRoundArgs;
  try {
    args = parseArgs(argv);
  } catch (e) {
    exitWithFailure("route-round:", 2, [(e as Error).message]);
  }
  const corpusDir = args.corpusDir ?? DEFAULT_CORPUS_DIR;
  const judgmentDir = args.judgmentDir ?? DEFAULT_JUDGMENT_DIR;

  const digest = armedHeadDigest(judgmentDir); // refuses exit 2 before any write
  const records = readRecords(corpusFilePath(corpusDir, args.pr, args.round));
  const { deep, candidates } = partition(records, digest);

  const manifest: RoutingManifest = {
    pr: args.pr,
    round: args.round,
    armed_digest: digest,
    deep_adjudication: deep,
    obvious_dismiss_candidates: candidates,
  };
  const routingDir = join(judgmentDir, "routing");
  mkdirSync(routingDir, { recursive: true });
  writeFileSync(join(routingDir, `${args.pr}-${args.round}.json`), `${JSON.stringify(manifest, null, 2)}\n`);

  process.stdout.write(
    `${JSON.stringify({
      pr: args.pr,
      round: args.round,
      armed_digest: digest,
      deep_adjudication: deep.length,
      obvious_dismiss_candidates: candidates.length,
    })}\n`,
  );
  return 0;
}

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2));
}
