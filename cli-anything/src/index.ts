#!/usr/bin/env bun
import { runManifest } from "./runner.ts";

/**
 * CLI entry: `cli-anything run --manifest <path>`
 * Parses the manifest, runs `warren run` with the merged env, and prints the
 * structured harness result (exit_class, stdout_excerpt, env_probe_result) as
 * JSON on stdout. INV-2/INV-3: the result carries no secret values.
 */
export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd !== "run") {
    console.error("usage: cli-anything run --manifest <path.yaml>");
    return 64;
  }

  const flagIdx = rest.indexOf("--manifest");
  const manifestPath = flagIdx >= 0 ? rest[flagIdx + 1] : undefined;
  if (!manifestPath) {
    console.error("usage: cli-anything run --manifest <path.yaml>");
    return 64;
  }

  const result = await runManifest(manifestPath);
  console.log(JSON.stringify(result));
  return result.exit_class === "ok" ? 0 : 1;
}

if (import.meta.main) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
