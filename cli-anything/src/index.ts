#!/usr/bin/env bun
import { runManifest } from "./runner.ts";
import type { ExitClass, HarnessResult } from "./types.ts";

const USAGE = "usage: cli-anything run --manifest <path.yaml>";

/** Harness exit_class → process exit code. */
const EXIT_CODES: Record<ExitClass, number> = {
  ok: 0,
  nonzero: 1,
  timeout: 124,
  spawn_error: 127,
};

/**
 * CLI entry: `cli-anything run --manifest <path>` (or `--manifest=<path>`).
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

  let result: HarnessResult;
  try {
    result = await runManifest(manifestPath);
  } catch (err) {
    console.error(`cli-anything: ${err instanceof Error ? err.message : String(err)}`);
    return 65;
  }
  console.log(JSON.stringify(result));
  return EXIT_CODES[result.exit_class];
}

if (import.meta.main) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(`cli-anything: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(65);
    });
}
