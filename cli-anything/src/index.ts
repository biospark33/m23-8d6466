#!/usr/bin/env bun
import { ZodError } from "zod";
import { runManifest } from "./runner.ts";
import type { ExitClass, HarnessResult } from "./types.ts";

const USAGE = [
  "usage: cli-anything run --manifest <path.yaml> [--timeout-ms <n>]",
  '  --manifest <path> | --manifest=<path>    manifest YAML path; values beginning',
  '                                           with "-" require the "=" form',
  "  --timeout-ms <n> | --timeout-ms=<n>      wall-clock timeout in ms (default 10 min)",
].join("\n");

/** Harness exit_class → process exit code. */
const EXIT_CODES: Record<ExitClass, number> = {
  ok: 0,
  nonzero: 1,
  timeout: 124,
  spawn_error: 127,
};

/**
 * Sanitize an error for stderr — never echo manifest content (INV-2).
 * Zod issues carry received values, so only paths + codes are printed; YAML
 * parse errors embed source excerpts, so other errors degrade to their class.
 */
function formatError(err: unknown): string {
  if (err instanceof ZodError) {
    const lines = err.issues.map(
      (i) => `  - ${i.path.length > 0 ? i.path.join(".") : "<root>"}: ${i.code}`,
    );
    return ["cli-anything: manifest validation failed:", ...lines].join("\n");
  }
  const name = err instanceof Error ? err.name : "Error";
  const code = err instanceof Error ? (err as NodeJS.ErrnoException).code : undefined;
  return `cli-anything: ${name}${code !== undefined ? ` (${code})` : ""}: failed to load or parse manifest`;
}

/** Parse a `--timeout-ms` value: positive integer ms, else undefined. */
function parseTimeoutMs(raw: string): number | undefined {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : undefined;
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

  let result: HarnessResult;
  try {
    result = await runManifest(manifestPath, { timeoutMs });
  } catch (err) {
    console.error(formatError(err));
    return 65;
  }
  console.log(JSON.stringify(result));
  return EXIT_CODES[result.exit_class];
}

if (import.meta.main) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(formatError(err));
      process.exit(65);
    });
}
