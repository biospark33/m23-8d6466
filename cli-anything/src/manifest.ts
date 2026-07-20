import { readFileSync, statSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import {
  type Manifest,
  ManifestSchema,
  type TeamManifest,
  TeamManifestSchema,
} from "./types.ts";

/** Maximum manifest file size accepted by parseManifestFile (1 MB). */
export const MAX_MANIFEST_SIZE_BYTES = 1024 * 1024;

/** Thrown when a manifest file exceeds MAX_MANIFEST_SIZE_BYTES. */
export class ManifestTooLargeError extends Error {
  constructor(
    public readonly path: string,
    public readonly size: number,
  ) {
    super(`manifest file too large: ${path} (${size} bytes)`);
    this.name = "ManifestTooLargeError";
  }
}

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
  const stats = statSync(path);
  if (stats.size > MAX_MANIFEST_SIZE_BYTES) {
    throw new ManifestTooLargeError(path, stats.size);
  }
  return parseManifest(readFileSync(path, "utf8"));
}

/** Parse and validate a P0.3 team manifest from a YAML string. */
export function parseTeamManifest(yaml: string): TeamManifest {
  const raw = parseYaml(yaml);
  return TeamManifestSchema.parse(raw);
}

/** Read a team manifest file from disk, then parse + validate it. */
export function parseTeamManifestFile(path: string): TeamManifest {
  const stats = statSync(path);
  if (stats.size > MAX_MANIFEST_SIZE_BYTES) {
    throw new ManifestTooLargeError(path, stats.size);
  }
  return parseTeamManifest(readFileSync(path, "utf8"));
}

/**
 * Sniff which manifest kind a YAML file holds: `team` when the root object
 * carries a `team` block, `single` otherwise. Validation happens in the
 * matching parse function; this only routes.
 */
export function manifestKind(path: string): "single" | "team" {
  const stats = statSync(path);
  if (stats.size > MAX_MANIFEST_SIZE_BYTES) {
    throw new ManifestTooLargeError(path, stats.size);
  }
  const raw: unknown = parseYaml(readFileSync(path, "utf8"));
  return typeof raw === "object" && raw !== null && !Array.isArray(raw) && "team" in raw
    ? "team"
    : "single";
}
