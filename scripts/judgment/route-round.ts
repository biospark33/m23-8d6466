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
import { isDeepStrictEqual } from "node:util";
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
  let pr: string | undefined;
  let round: string | undefined;
  let corpusDir: string | undefined;
  let judgmentDir: string | undefined;
  const { flagTokens } = tokenizeArgs(argv, {
    valueFlags: ["--pr", "--round", "--corpus-dir", "--judgment-dir"],
  });
  parseValueFlags(flagTokens, {
    flags: ["--pr", "--round", "--corpus-dir", "--judgment-dir"],
    onValue: (flag, v) => {
      if (flag === "--pr") pr = v;
      else if (flag === "--round") round = v;
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
  // Strict digits, never Number() coercion: 0x10/1e2/" 5" all coerce to valid
  // integers and would route a round that was never named (F14). Same strict
  // shape as confirm-outcome's parsePositiveInt: a 20-digit pr is not a safe
  // integer and must fail HERE naming the flag, not later as an unrelated
  // shard miss (R2-L).
  for (const [name, v] of [["--pr", pr], ["--round", round]] as const) {
    if (v === undefined) throw new Error(`${name} <N> is required (a positive integer)`);
    if (!/^\d+$/.test(v)) throw new Error(`${name} must be a positive integer in plain digits (got "${v}")`);
    const n = Number(v);
    if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`${name} must be a safe positive integer (got "${v}")`);
  }
  return { pr: Number(pr), round: Number(round), corpusDir, judgmentDir };
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
  // Drop ONLY the trailing empty element split("\n") yields for a final
  // newline — interior blanks must reach the verifier, which refuses them by
  // physical line number (a torn double-append is a defect, not whitespace).
  const lines = existsSync(file) ? readFileSync(file, "utf8").split("\n") : [];
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
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
 * The recorded jev clause — the same regex idiom as parseIsRealDefect
 * (ab-report.ts), applied to the `disposition=` clause written by
 * observe-round's rationaleFrom (pinned by the cross-pin test). Never a
 * re-judge. Absent or non-plain-decimal clauses (e.g. exponent form, which
 * String(p) renders as "1e-7") are "not-recorded" — the fail-safe lane.
 */
export function parseDispositionProbability(rationale: string | undefined): { disposition: string; p: number } | "not-recorded" {
  const m = rationale?.match(/jev:.*disposition=([a-z][a-z_-]*) p=([0-9]+(?:\.[0-9]+)?)(?![0-9.eE])/);
  return m ? { disposition: m[1]!, p: Number.parseFloat(m[2]!) } : "not-recorded";
}

export interface RoutingEntry {
  finding_id: string;
  /** The jev rationale — present ONLY when the record is a jev-arm record whose recorded rationale yielded a parseable disposition clause (AC4). */
  rationale?: string;
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
 * MIN_ROUTE_CONFIDENCE <= p <= 1 (a percent-style p=97 is malformed, not
 * confident). Everything else — other dispositions, sub-threshold,
 * out-of-range, or absent clauses, records without a jev answer — goes
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
      clause.p >= MIN_ROUTE_CONFIDENCE &&
      clause.p <= 1;
    const entry: RoutingEntry = { finding_id: r.finding_id, armed_state_digest: digest };
    // AC4: the entry carries "the jev rationale" whenever the record carries
    // one — clause parseability gates the LANE, not the rationale's presence.
    if (r.arm === "jev" && r.rationale) entry.rationale = r.rationale;
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
    const corpusDir = args.corpusDir ?? DEFAULT_CORPUS_DIR;
    const judgmentDir = args.judgmentDir ?? DEFAULT_JUDGMENT_DIR;

    const digest = armedHeadDigest(judgmentDir); // refuses exit 2 before any write
    const shard = corpusFilePath(corpusDir, args.pr, args.round);
    // readRecords returns [] for a missing file — a typo'd round would route
    // nobody as an empty manifest and exit 0. Absent findings are absent,
    // never an empty manifest (F4).
    if (!existsSync(shard)) {
      exitWithFailure("route-round:", 2, [
        `no corpus shard for pr ${args.pr} round ${args.round} at ${shard} — absent findings are absent, never an empty manifest`,
      ]);
    }
    const records = readRecords(shard);
    // A zero-byte or otherwise record-less shard that EXISTS is truncation,
    // not an empty round — an empty-lane manifest would launder it as exit 0.
    if (records.length === 0) {
      exitWithFailure("route-round:", 2, [
        `corpus shard ${shard} exists but holds zero records — truncation is not an empty round; restore the shard before routing`,
      ]);
    }
    const { deep, candidates } = partition(records, digest);

    const manifest: RoutingManifest = {
      pr: args.pr,
      round: args.round,
      armed_digest: digest,
      deep_adjudication: deep,
      obvious_dismiss_candidates: candidates,
    };
    const routingDir = join(judgmentDir, "routing");
    const manifestPath = join(routingDir, `${args.pr}-${args.round}.json`);
    if (existsSync(manifestPath)) {
      // The prior manifest is operator-owned provenance: corrupt or hand-edited
      // JSON must be named AS the manifest — never a raw SyntaxError, and never
      // a wrong-cause "shard changed" diagnosis (R3-7).
      let priorRaw: unknown;
      try {
        priorRaw = JSON.parse(readFileSync(manifestPath, "utf8"));
      } catch {
        exitWithFailure("route-round:", 2, [
          `existing routing manifest at ${manifestPath} is not valid JSON — delete it explicitly to re-route`,
        ]);
      }
      const prior = priorRaw as RoutingManifest;
      if (
        typeof priorRaw !== "object" ||
        priorRaw === null ||
        Array.isArray(priorRaw) ||
        typeof prior.armed_digest !== "string" ||
        !Array.isArray(prior.deep_adjudication) ||
        !Array.isArray(prior.obvious_dismiss_candidates)
      ) {
        exitWithFailure("route-round:", 2, [
          `existing routing manifest at ${manifestPath} does not match the routing manifest shape — the manifest was edited, not the shard`,
        ]);
      }
      if (prior.armed_digest !== digest) {
        exitWithFailure("route-round:", 2, [
          `manifest ${manifestPath} exists under a different armed digest — prior routing provenance is not overwritten`,
        ]);
      }
      // Same digest: only an identical routing is an idempotent rewrite.
      // Deep-compare the PARSED JSON (never raw file text — a pretty-print
      // difference must not false-trip): a different partition under the same
      // digest means the corpus shard changed since the manifest was written.
      if (!isDeepStrictEqual(prior, manifest)) {
        exitWithFailure("route-round:", 2, [
          `manifest ${manifestPath} differs from the new routing under the same armed digest — the corpus shard changed since it was written; delete the manifest explicitly to re-route`,
        ]);
      }
    }
    mkdirSync(routingDir, { recursive: true });
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

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
  } catch (e) {
    // The 0/2 exit contract: a torn corpus line or a failed write is a fatal
    // exit 2 with a clean message, never an uncaught exit-1 stack (F5).
    exitWithFailure("route-round:", 2, [(e as Error).message]);
  }
}

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2));
}
