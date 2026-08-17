#!/usr/bin/env bun
/**
 * CLI: sandbox-teardown — the operator-facing surface of harvest + teardown (DF2.5).
 *
 * Usage:
 *   sandbox-teardown <run-id> [--no-harvest] [--driver <name>] [--dir <path>]
 *   sandbox-teardown harvest <run-id> [--driver <name>] [--dir <path>]
 *
 * The default mode runs the full ordered teardown (spend → artifacts →
 * harvest → revoke → verify → destroy → close); `harvest <run-id>` runs
 * harvestRun only and leaves the record open — closure is teardown's last
 * step. `--driver` defaults to $QDS_PROVIDER_DRIVER or "fake"; `--dir` (or
 * $QDS_RUNS_DIR) selects the records directory; the host git repo is the cwd.
 *
 * The provider key API is built lazily, only when the record carries a
 * keyHash — keyless runs work offline, and a keyed run without
 * $OPENROUTER_PROVISIONING_KEY fails before anything is mutated. Errors print
 * `!! <code>: <message>` plus `next: <remediation>` and exit 1; remediation
 * references env-var NAMES only and key material is never printed.
 */

import {
  RunRecordStore,
  harvestRun,
  openRouterKeyApi,
  resolveDriver,
  teardownSandbox,
  type RunRecord,
  type TeardownDeps,
} from "../src/providers/index.ts";
import { newRequestId, setLogSink } from "../src/swarmclaw/log.ts";
import { parseValueFlags } from "./lib/cli-args.ts";

// Structured logs go to stderr so stdout carries only the command's output.
if (import.meta.main) {
  setLogSink((entry) => {
    process.stderr.write(`${JSON.stringify(entry)}\n`);
  });
}

const HELP = [
  "Usage: sandbox-teardown [harvest] <run-id> [--no-harvest] [--driver <name>] [--dir <path>]",
  "",
  "  <run-id>                full ordered teardown: spend → artifacts → harvest →",
  "                         revoke → verify → destroy → close",
  "  harvest <run-id>        harvest + artifacts only; the record stays open",
  "",
  "  --no-harvest            waive the harvest gate (AC3) only — logged to the run",
  "                         log, never written to the record",
  "  --driver <name>         provider driver (default $QDS_PROVIDER_DRIVER or fake)",
  "  --dir <path>            records directory (default $QDS_RUNS_DIR)",
  "",
];

const VALUE_FLAGS = ["--driver", "--dir"] as const;
const BOOL_FLAGS = new Set(["--no-harvest"]);

export interface ParsedArgs {
  mode: "harvest" | "teardown";
  runId?: string;
  noHarvest: boolean;
  driver?: string;
  dir?: string;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const positionals: string[] = [];
  const flagTokens: string[] = [];
  let noHarvest = false;
  const known = new Set<string>(VALUE_FLAGS);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (!a.startsWith("-")) {
      positionals.push(a);
      continue;
    }
    if (BOOL_FLAGS.has(a)) {
      noHarvest = true;
      continue;
    }
    flagTokens.push(a);
    if (known.has(a) && i + 1 < argv.length) flagTokens.push(argv[++i] as string);
  }

  const isHarvest = positionals[0] === "harvest";
  const out: ParsedArgs = {
    mode: isHarvest ? "harvest" : "teardown",
    runId: isHarvest ? positionals[1] : positionals[0],
    noHarvest,
  };
  parseValueFlags(flagTokens, {
    flags: VALUE_FLAGS,
    onValue: (flag, value) => {
      if (flag === "--driver") out.driver = value;
      else out.dir = value;
    },
    help: HELP,
  });
  return out;
}

function fail(out: (s: string) => void, code: string, message: string, remediation?: string): void {
  out(`!! ${code}: ${message}\n`);
  if (remediation !== undefined) out(`next: ${remediation}\n`);
}

export async function run(argv: readonly string[], out: (s: string) => void): Promise<number> {
  const parsed = parseArgs(argv);
  if (parsed.runId === undefined) {
    throw new Error(`missing <run-id>\n${HELP.join("\n")}`);
  }
  if (parsed.mode === "harvest" && parsed.noHarvest) {
    throw new Error(`harvest mode has no harvest gate to waive: --no-harvest is a teardown flag\n${HELP.join("\n")}`);
  }
  const requestId = newRequestId();
  const driver = resolveDriver(parsed.driver ?? process.env.QDS_PROVIDER_DRIVER ?? "fake", {
    requestId,
    runId: parsed.runId,
  });
  const store = new RunRecordStore({ ...(parsed.dir === undefined ? {} : { dir: parsed.dir }), requestId });

  let rec: RunRecord;
  try {
    rec = store.get(parsed.runId);
  } catch (e) {
    fail(
      out,
      "no-record",
      `no run record for ${parsed.runId}: ${(e as Error).message}`,
      "check the run id; records live under $QDS_RUNS_DIR (default .sandbox/runs) — create the run first",
    );
    return 1;
  }

  try {
    // Keyed records need the key API (spend/revoke/verify); keyless runs work
    // offline. openRouterKeyApi throws its own provisioning-key-missing
    // remediation before anything is mutated.
    const keyApi = rec.keyHash === undefined ? undefined : openRouterKeyApi();
    const deps: TeardownDeps = {
      driver,
      store,
      ...(keyApi === undefined ? {} : { keyApi }),
      requestId,
      gitCwd: process.cwd(),
    };
    if (parsed.mode === "harvest") {
      const res = await harvestRun(deps, parsed.runId);
      out(res.outcome === "harvested" ? `harvested: ${res.count}\n` : "harvested: none\n");
      return 0;
    }
    // The waiver goes to the run log + stdout, never the record (INV-5).
    if (parsed.noHarvest) out(`teardown.harvest_waived ${parsed.runId}\n`);
    await teardownSandbox(deps, parsed.runId, { noHarvest: parsed.noHarvest });
    out(`torn down: ${parsed.runId}\n`);
    return 0;
  } catch (e) {
    const err = e as { code?: string; remediation?: string; message?: string };
    fail(out, err.code ?? "error", err.message ?? String(e), err.remediation);
    return 1;
  }
}

if (import.meta.main) {
  try {
    process.exit(await run(process.argv.slice(2), (s) => process.stdout.write(s)));
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n`);
    process.exit(1);
  }
}
