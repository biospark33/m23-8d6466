#!/usr/bin/env bun
/**
 * Phase-0 exit gate (Story P0.11) — PRD §13 Phase-0 aggregated assertion check.
 *
 * Runs one assertion per PRD §13 Phase-0 clause and emits a single binary
 * verdict. Clauses whose predecessor story was killed by the Warren decision
 * are recorded VOID (excluded from the verdict) rather than deleted, so the
 * report shows they were dropped deliberately.
 *
 * Clause map:
 *   1   P0.3  merged JSON from a mixed-model team run   (cli-anything; pi-team-launch.sh never existed)
 *   2   P0.2  >=2 agents exchanging >=2 messages
 *   3   P0.4  hard cap wired to a non-zero exit         (STRUCTURAL — story killed, guard absorbed)
 *   4   P0.5  pi-lens headless warning-count proxy      (clause 4's second branch; TDI is TUI-only)
 *   4b  P0.6  warm LSP diagnostics + navigation         (SCOPED — 4 P0.6 ACs are story-level PARTIAL)
 *   5   P0.1  Archon per-node env patch                 (VOID — story killed)
 *   6   P0.7  SwarmClaw + Hindsight MCP bridge          (Hindsight half live)
 *       P0.8  Telegram plugin installed                 (VOID — story killed)
 *   7   P0.9  Hindsight retain->recall->reflect
 *   7b  P0.10 gitnexus context/impact return real data
 *   8   P0.2  OQ-1..6 decisions recorded
 *
 * Output:  a human-readable per-assertion table on stdout, terminated by
 *          `PHASE_0_GATE: PASS` or `PHASE_0_GATE: FAIL`; the machine-readable
 *          GateReport is written to the report path.
 * Exit:    0 all live assertions green / 1 any red or unproven / 2 fatal.
 * Flags:   --report <path>   override the report destination
 *          --help
 *
 * A SKIP is not a pass: an assertion that could not be evaluated fails the
 * gate. "Could not check" is precisely what an exit gate exists to surface.
 *
 * Run: bun scripts/phase0-exit-gate.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { parseValueFlags } from "./lib/cli-args.ts";
import { envAssertions } from "../src/gate/assertions/p0-1-env.ts";
import { comsAssertions } from "../src/gate/assertions/p0-2-coms.ts";
import { mixedModelAssertions } from "../src/gate/assertions/p0-3-mixed-model.ts";
import { guardAssertions } from "../src/gate/assertions/p0-4-guard.ts";
import { piLensAssertions } from "../src/gate/assertions/p0-5-pi-lens.ts";
import { lspAssertions } from "../src/gate/assertions/p0-6-lsp.ts";
import { mcpBridgeAssertions } from "../src/gate/assertions/p0-7-mcp-bridge.ts";
import { memoryAssertions } from "../src/gate/assertions/p0-9-memory.ts";
import { gitnexusAssertions } from "../src/gate/assertions/p0-10-gitnexus.ts";
import {
  type GateAssertion,
  GateAssertionSchema,
  type GateReport,
  runGate,
} from "../src/gate/gate-runner.ts";

const REPO_ROOT = path.join(import.meta.dir, "..");
const DEFAULT_REPORT = path.join(
  REPO_ROOT,
  "_bmad-output",
  "sprint-artifacts",
  "phase-0",
  "phase0-gate-report.json",
);

const HELP = [
  "phase0-exit-gate — PRD §13 Phase-0 aggregated assertion check",
  "",
  "Usage: bun scripts/phase0-exit-gate.ts [--report <path>]",
  "",
  "  --report <path>  where to write the JSON GateReport",
  "                   (default: _bmad-output/sprint-artifacts/phase-0/phase0-gate-report.json)",
  "  --help, -h       show this help",
  "",
  "Exit codes: 0 = PASS, 1 = FAIL, 2 = fatal before any assertion ran.",
].join("\n");

function parseArgs(argv: readonly string[]): { reportPath: string } {
  let reportPath = DEFAULT_REPORT;
  // Reuses the repo's shared flag grammar (--f v / --f=v / --help / unknown
  // flag throws) rather than re-implementing it, as the other value-taking
  // scripts do.
  parseValueFlags(argv, {
    flags: ["--report"],
    onValue: (_flag, value) => {
      reportPath = path.resolve(value);
    },
    help: HELP.split("\n"),
  });
  return { reportPath };
}

function buildAssertions(): GateAssertion[] {
  const assertions = [
    ...envAssertions(REPO_ROOT),
    ...mixedModelAssertions(REPO_ROOT),
    ...comsAssertions(REPO_ROOT),
    ...guardAssertions(REPO_ROOT),
    ...piLensAssertions(REPO_ROOT),
    ...lspAssertions(REPO_ROOT),
    ...mcpBridgeAssertions(),
    ...memoryAssertions(),
    ...gitnexusAssertions(REPO_ROOT),
  ];

  // Validate every definition up front. A malformed assertion is a coding
  // error in the gate itself, and must abort loudly (exit 2) rather than
  // silently contribute a misleading result to a Phase-0 verdict.
  for (const a of assertions) {
    const parsed = GateAssertionSchema.safeParse(a);
    if (!parsed.success) {
      throw new Error(`invalid gate assertion "${a.id}": ${parsed.error.message}`);
    }
  }

  const ids = assertions.map((a) => a.id);
  const duplicates = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (duplicates.length > 0) {
    throw new Error(`duplicate gate assertion id(s): ${[...new Set(duplicates)].join(", ")}`);
  }

  return assertions;
}

const GLYPH: Record<string, string> = {
  pass: "PASS",
  fail: "FAIL",
  skip: "SKIP",
  void: "VOID",
};

function render(report: GateReport): string {
  const lines: string[] = [];
  lines.push("Phase-0 exit gate — PRD §13 aggregated assertion check");
  lines.push("");
  for (const a of report.assertions) {
    lines.push(
      `[${GLYPH[a.status] ?? a.status}] ${a.id}  (${a.story}, ${a.prd_clause})  ${a.duration_ms}ms`,
    );
    if (a.detail) lines.push(`       ${a.detail}`);
  }
  lines.push("");
  lines.push(
    `Totals: ${report.summary.pass} pass, ${report.summary.fail} fail, ` +
      `${report.summary.skip} skip (unproven), ${report.summary.void} void (clause dropped). ` +
      `${report.total_duration_ms}ms`,
  );
  const reds = report.assertions.filter((a) => a.status === "fail" || a.status === "skip");
  if (reds.length > 0) {
    lines.push("");
    lines.push("Blocking assertions:");
    for (const r of reds) lines.push(`  - ${r.id}: ${r.detail ?? "no detail"}`);
  }
  lines.push("");
  lines.push(`PHASE_0_GATE: ${report.overall}`);
  return `${lines.join("\n")}\n`;
}

async function main(): Promise<void> {
  const { reportPath } = parseArgs(process.argv.slice(2));
  const report = await runGate(buildAssertions());

  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  process.stdout.write(render(report));
  process.stderr.write(`gate report written to ${reportPath}\n`);
  // exitCode (not process.exit) so a backpressured stdout pipe drains first.
  process.exitCode = report.overall === "PASS" ? 0 : 1;
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    process.stderr.write(
      `phase0-exit-gate fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
    );
    process.exit(2);
  });
}
