import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { type Manifest, ManifestSchema } from "./types.ts";

/**
 * Parse and validate a manifest from a YAML string.
 * Throws on invalid YAML or on a schema violation (missing name/command,
 * non-string env values, unknown keys).
 */
export function parseManifest(yaml: string): Manifest {
  const raw = parseYaml(yaml);
  return ManifestSchema.parse(raw);
}

/** Read a manifest file from disk, then parse + validate it. */
export function parseManifestFile(path: string): Manifest {
  return parseManifest(readFileSync(path, "utf8"));
}
