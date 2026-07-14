#!/usr/bin/env bun
import { YAMLParseError } from "yaml";
import { ZodError } from "zod";
import { ManifestTooLargeError } from "./manifest.ts";
import { runManifest } from "./runner.ts";
import type { ExitClass, HarnessResult } from "./types.ts";

const USAGE = [
  "usage: cli-anything run [--manifest <path.yaml>] [--timeout-ms <n>] [-- <args>]",
  '  --manifest <path> | --manifest=<path>    manifest YAML path; values beginning',
  '                                           with "-" require the "=" form; repeated',
  '                                           flags: first wins (space or = form)',
  "  --timeout-ms <n> | --timeout-ms=<n>      wall-clock timeout in ms: a decimal",
  "                                           integer in 1..2147483647 (default 10 min)",
  "  --                                       end of options; first token after --",
  "                                           is used as the manifest path if none",
  "                                           was given before it",
  "  unknown flags and stray positional args are rejected (exit 64)",
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
  if (err instanceof ManifestTooLargeError) {
    return {
      exitCode: 65,
      message: "cli-anything: manifest file too large",
    };
  }
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

  // Split at the first "--": known flags are parsed only from preDash; the
  // first post-"--" token may supply the manifest path.
  const dashIdx = rest.indexOf("--");
  const preDash = dashIdx >= 0 ? rest.slice(0, dashIdx) : rest;
  const postDash = dashIdx >= 0 ? rest.slice(dashIdx + 1) : [];

  let manifestPath: string | undefined;
  let timeoutMs: number | undefined;
  let timeoutSeen = false;
  const consumed = new Set<number>();

  for (let i = 0; i < preDash.length; i++) {
    const arg = preDash[i]!;

    if (arg === "--manifest") {
      consumed.add(i);
      const value = preDash[i + 1];
      if (value === undefined || value.startsWith("-")) {
        console.error(USAGE);
        return 64;
      }
      if (manifestPath === undefined) {
        manifestPath = value;
      }
      consumed.add(i + 1);
      i++;
      continue;
    }

    if (arg.startsWith("--manifest=")) {
      consumed.add(i);
      if (manifestPath === undefined) {
        manifestPath = arg.slice("--manifest=".length);
      }
      continue;
    }

    if (arg === "--timeout-ms") {
      consumed.add(i);
      const value = preDash[i + 1];
      if (value === undefined || value.startsWith("-")) {
        console.error(USAGE);
        return 64;
      }
      if (!timeoutSeen) {
        timeoutMs = parseTimeoutMs(value);
        timeoutSeen = true;
      }
      consumed.add(i + 1);
      i++;
      continue;
    }

    if (arg.startsWith("--timeout-ms=")) {
      consumed.add(i);
      if (!timeoutSeen) {
        timeoutMs = parseTimeoutMs(arg.slice("--timeout-ms=".length));
        timeoutSeen = true;
      }
    }
  }

  // Reject unknown flags and stray positional arguments in preDash.
  for (let i = 0; i < preDash.length; i++) {
    if (consumed.has(i)) continue;
    const arg = preDash[i]!;
    if (arg.startsWith("-")) {
      console.error(`cli-anything: unknown flag '${arg}'\n${USAGE}`);
      return 64;
    }
    console.error(`cli-anything: unexpected positional argument '${arg}'\n${USAGE}`);
    return 64;
  }

  // If no --manifest was given before "--", the first post-"--" token is the
  // manifest path; remaining post-"--" tokens are ignored (they are reserved
  // for future passthrough to the payload command).
  if (manifestPath === undefined && postDash.length > 0) {
    manifestPath = postDash[0];
  }

  if (!manifestPath) {
    console.error(USAGE);
    return 64;
  }

  if (timeoutSeen && timeoutMs === undefined) {
    console.error(USAGE);
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
