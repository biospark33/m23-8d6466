#!/usr/bin/env bun
/**
 * CLI: prove every slug in a roster is spawnable before a run starts.
 *
 *   bun scripts/roster-check.ts --roster config/rosters/qds-default.roster.yaml
 *
 * One row per role on stdout:
 *
 *   planner · openrouter/anthropic/claude-haiku-4.5 · pi:pass · provider:pass · source:bundled
 *
 * Exit codes: `0` all roles pass, `1` at least one slug rejected, `2` a gate
 * could not be evaluated. **`2` dominates `1`** — an unevaluated gate is not a
 * complete verdict — and the report still lists every rejection.
 *
 * stdout carries ONLY the operator table plus problem/warning lines; the
 * structured per-role records from the Observability Contract go to stderr, so
 * a caller can pipe either without the other.
 *
 * INV-1: no credential is read, built, or emitted anywhere on this path — the
 * provider gate hits a public endpoint and the registry reader takes only `id`
 * and `cost` out of `~/.pi/agent/models.json`.
 */

import { loadRoster, RosterError } from "../src/phase-engine/roster/schema.ts";
import { type RosterReport, validateRoster } from "../src/phase-engine/roster/validate.ts";
import { parseValueFlags } from "./lib/cli-args.ts";

export interface RosterCheckArgs {
  roster?: string;
  requestId?: string;
}

export function parseArgs(argv: string[]): RosterCheckArgs {
  const out: RosterCheckArgs = {};
  parseValueFlags(argv, {
    flags: ["--roster", "--request-id"],
    onValue: (flag, v) => {
      if (flag === "--roster") out.roster = v;
      else out.requestId = v;
    },
    help: [
      "Usage: roster-check --roster <path> [--request-id <id>]",
      "",
      "Puts every roster slug through pi's merged catalog AND the provider's",
      "live model list. A slug passing only one gate is rejected.",
      "",
      "Exit: 0 all pass · 1 a slug was rejected · 2 a gate was unevaluable",
      "",
    ],
  });
  return out;
}

/**
 * Role names and slugs come out of an operator-supplied YAML file and land on a
 * terminal \u2014 a trust boundary. Escaped here so a crafted roster cannot repaint
 * or misreport the verdict table it appears in:
 *
 *  - C0 + DEL (`\x00-\x1f\x7f`) \u2014 ESC, CR, the classic ANSI introducers;
 *  - C1 (`\x80-\x9f`) \u2014 U+009B IS a working CSI introducer and U+009D an OSC
 *    one on any UTF-8 terminal, so stopping at DEL would miss the exact
 *    sequences this exists to stop;
 *  - line separators and bidi overrides (U+2028/2029, RLO/LRO, the isolates) \u2014
 *    U+202E alone lets a role name visually reorder the `pi:`/`provider:`
 *    verdict text next to it.
 *
 * Every character in the class is written as an escape, never as a literal:
 * a raw NUL in the source makes git treat this file as binary and drop it from
 * the diff, which would take the whole operator surface out of code review.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: escaping them is the point
const CONTROL = /[\x00-\x1f\x7f-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;
export function sanitize(s: string): string {
  return s.replace(CONTROL, (c) => {
    const code = c.charCodeAt(0);
    return code <= 0xff
      ? `\\x${code.toString(16).padStart(2, "0")}`
      : `\\u${code.toString(16).padStart(4, "0")}`;
  });
}

/** Render the operator table + any problems. Returns the lines, newline-free. */
export function formatReport(report: RosterReport): string[] {
  const lines = report.roles.map(
    (r) =>
      `${sanitize(r.role)} · ${sanitize(r.slug)} · pi:${r.piCatalog} · ` +
      `provider:${r.providerApi} · source:${r.source ?? "none"}`,
  );
  for (const w of report.warnings) lines.push(`WARN ${sanitize(w)}`);
  for (const r of report.roles) {
    for (const p of r.problems) lines.push(`FAIL [${sanitize(r.role)}] ${sanitize(p)}`);
  }
  for (const p of report.problems) lines.push(`FAIL ${sanitize(p)}`);
  return lines;
}

export async function main(argv: string[]): Promise<number> {
  let args: RosterCheckArgs;
  try {
    args = parseArgs(argv);
  } catch (e) {
    process.stdout.write(`FAIL bad_args: ${(e as Error).message}\n`);
    return 2;
  }
  if (args.roster === undefined) {
    process.stdout.write("FAIL bad_args: --roster <path> is required\n");
    return 2;
  }

  // INV-2: the roster is schema-parsed (and its path confined to the repo root)
  // BEFORE any probe fires, so a malformed roster costs zero network calls.
  const requestId = args.requestId ?? crypto.randomUUID();
  try {
    const roster = loadRoster(args.roster);
    const report = await validateRoster(roster, { requestId });
    process.stdout.write(`${formatReport(report).join("\n")}\n`);
    for (const record of report.roles) {
      // stderr is the same terminal by default, and JSON.stringify escapes only
      // C0 — U+009B (CSI), U+009D (OSC) and U+202E all survive it verbatim. So
      // the operator-supplied fields are sanitized here too, or the sibling
      // stream simply bypasses the stdout hardening.
      process.stderr.write(
        `${JSON.stringify({
          ...record,
          role: sanitize(record.role),
          slug: sanitize(record.slug),
          provider: sanitize(record.provider),
          problems: record.problems.map(sanitize),
          warnings: record.warnings.map(sanitize),
        })}\n`,
      );
    }
    process.stderr.write(
      `${JSON.stringify({
        requestId,
        roster: sanitize(roster.path),
        roles: report.roles.length,
        exitCode: report.exitCode,
        catalog_probe_ms: report.catalogProbeMs,
        provider_probe_ms: report.providerProbeMs,
        durationMs: report.durationMs,
      })}\n`,
    );
    return report.exitCode;
  } catch (e) {
    if (e instanceof RosterError) {
      for (const p of e.problems) process.stdout.write(`FAIL ${sanitize(p)}\n`);
      process.stderr.write(
        `${JSON.stringify({ requestId, error: { code: e.code, message: sanitize(e.message) } })}\n`,
      );
      // A roster that is present but wrong is a rejection; one that could not be
      // READ is an unavailable control (INV-4) — a typo'd path must not read as
      // "your slugs are bad".
      return e.code === "roster_unreadable" ? 2 : 1;
    }
    // An unexpected failure is an unevaluated gate, not a pass (INV-4).
    process.stdout.write(`FAIL ${sanitize((e as Error).message)}\n`);
    process.stderr.write(
      `${JSON.stringify({
        requestId,
        error: { code: "roster_check_failed", message: sanitize((e as Error).message) },
      })}\n`,
    );
    return 2;
  }
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
