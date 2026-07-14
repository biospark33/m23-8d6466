#!/usr/bin/env bun
import { YAMLParseError } from "yaml";
import { ZodError } from "zod";
import { runManifest } from "./runner.ts";
import type { ExitClass, HarnessResult } from "./types.ts";

const USAGE = [
  "usage: cli-anything run --manifest <path.yaml> [--timeout-ms <n>]",
  '  --manifest <path> | --manifest=<path>    manifest YAML path; values beginning',
  '                                           with "-" require the "=" form; repeated',
  '                                           flags: first "--manifest=" wins, else',
  "                                           the first space-separated form",
  "  --timeout-ms <n> | --timeout-ms=<n>      wall-clock timeout in ms: a decimal",
  "                                           integer in 1..2147483647 (default 10 min)",
  "  unknown flags are rejected with this usage text (exit 64)",
].join("\n");

/** Harness exit_class → process exit code. */
const EXIT_CODES: Record<ExitClass, number> = {
  ok: 0,
  nonzero: 1,
  timeout: 124,
  spawn_error: 127,
};

/**
 * Map a harness result's exit_class to a process exit code. An out-of-union
 * class (contract drift with runner.ts) is a FAILURE, never a silent success:
 * note it on stderr and return 1 rather than exiting 0 via `undefined`.
 */
export function exitCodeFor(result: HarnessResult): number {
  const code: number | undefined = EXIT_CODES[result.exit_class];
  if (code === undefined) {
    console.error(
      `cli-anything: unknown exit_class '${String(result.exit_class)}' — treating as failure`,
    );
    return 1;
  }
  return code;
}

/**
 * Classify a manifest-load/parse failure into a process exit code plus a
 * sanitized stderr message (INV-2: never echo manifest content — Zod issues
 * carry received values, YAML error messages embed source excerpts, so only
 * paths/codes/positions are printed):
 *   - ZodError            → 65 EX_DATAERR: issue paths + codes only
 *   - YAMLParseError      → 65 EX_DATAERR: issue code + line/column position
 *   - ENOENT (no such file) → 66 EX_NOINPUT: includes the manifest path — it is
 *     operator-supplied argv, not manifest content, so it is safe to echo
 *   - anything else       → 70 EX_SOFTWARE: an internal bug, not bad input
 */
function classifyError(
  err: unknown,
  manifestPath?: string,
): { exitCode: number; message: string } {
  if (err instanceof ZodError) {
    const lines = err.issues.map(
      (i) => `  - ${i.path.length > 0 ? i.path.join(".") : "<root>"}: ${i.code}`,
    );
    return {
      exitCode: 65,
      message: ["cli-anything: manifest validation failed:", ...lines].join("\n"),
    };
  }
  if (err instanceof YAMLParseError) {
    // linePos is a [{line, col}, {line, col}] start/end pair; the start
    // position is what a user needs to locate the syntax error.
    const start = err.linePos?.[0];
    const where = start !== undefined ? ` at line ${start.line}, column ${start.col}` : "";
    return {
      exitCode: 65,
      message: `cli-anything: YAML syntax error in manifest${where}: ${err.code}`,
    };
  }
  const code = err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined;
  if (code === "ENOENT") {
    return {
      exitCode: 66,
      message: `cli-anything: manifest not found${manifestPath !== undefined ? `: ${manifestPath}` : ""}`,
    };
  }
  const name = err instanceof Error ? err.name : typeof err;
  return {
    exitCode: 70,
    message: `cli-anything: internal error while running manifest (${name})`,
  };
}

/** Largest timeout the runtime's setTimeout accepts (2^31-1); runner.ts clamps to this too. */
const MAX_TIMEOUT_MS = 2_147_483_647;

/** Parse a `--timeout-ms` value: decimal digits only, in 1..2^31-1, else undefined. */
function parseTimeoutMs(raw: string): number | undefined {
  if (!/^\d+$/.test(raw)) return undefined;
  const n = Number(raw);
  return n > 0 && n <= MAX_TIMEOUT_MS ? n : undefined;
}

/** True for a recognized flag in either `--flag value` or `--flag=value` form. */
function isKnownFlag(arg: string): boolean {
  return (
    arg === "--manifest" ||
    arg.startsWith("--manifest=") ||
    arg === "--timeout-ms" ||
    arg.startsWith("--timeout-ms=")
  );
}

/**
 * CLI entry: `cli-anything run --manifest <path>` (or `--manifest=<path>`;
 * values beginning with "-" require the "=" form), optional
 * `--timeout-ms <n>` (or `--timeout-ms=<n>`).
 * Parses the manifest, runs `warren run` with the merged env, and prints the
 * structured harness result (exit_class, stdout_excerpt, env_probe_result) as
 * JSON on stdout. INV-2/INV-3: the result carries no secret values.
 */
export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd !== "run") {
    console.error(USAGE);
    return 64;
  }

  let manifestPath: string | undefined;
  const eqArg = rest.find((a) => a.startsWith("--manifest="));
  if (eqArg !== undefined) {
    manifestPath = eqArg.slice("--manifest=".length);
  } else {
    const flagIdx = rest.indexOf("--manifest");
    const value = flagIdx >= 0 ? rest[flagIdx + 1] : undefined;
    if (value !== undefined && !value.startsWith("-")) manifestPath = value;
  }
  if (!manifestPath) {
    console.error(USAGE);
    return 64;
  }

  let timeoutMs: number | undefined;
  const eqTimeout = rest.find((a) => a.startsWith("--timeout-ms="));
  const timeoutSeen = eqTimeout !== undefined || rest.includes("--timeout-ms");
  if (eqTimeout !== undefined) {
    timeoutMs = parseTimeoutMs(eqTimeout.slice("--timeout-ms=".length));
  } else if (timeoutSeen) {
    const value = rest[rest.indexOf("--timeout-ms") + 1];
    timeoutMs =
      value !== undefined && !value.startsWith("-") ? parseTimeoutMs(value) : undefined;
  }
  if (timeoutSeen && timeoutMs === undefined) {
    console.error(USAGE);
    return 64;
  }

  // Any remaining arg starting with "-" is an unknown flag (a typo like
  // --timout-ms must not be silently ignored). Flag VALUES never start with
  // "-" — the space-form extraction above rejects those already.
  const unknownFlag = rest.find((a) => a.startsWith("-") && !isKnownFlag(a));
  if (unknownFlag !== undefined) {
    console.error(`cli-anything: unknown flag '${unknownFlag}'\n${USAGE}`);
    return 64;
  }

  let result: HarnessResult;
  try {
    result = await runManifest(manifestPath, { timeoutMs });
  } catch (err) {
    const { exitCode, message } = classifyError(err, manifestPath);
    console.error(message);
    return exitCode;
  }
  console.log(JSON.stringify(result));
  return exitCodeFor(result);
}

if (import.meta.main) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      const { exitCode, message } = classifyError(err);
      console.error(message);
      process.exit(exitCode);
    });
}
