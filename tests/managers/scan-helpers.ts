/**
 * Shared fork/zeropoint import scanners for the A1 manager suites (one copy —
 * the two hand-copied versions drifted in scope during round-2 review).
 *
 * Charter §5.4 / AC6: zero fork/zeropoint imports anywhere in the factory
 * graph. These helpers extract import/export/require/dynamic-import
 * specifiers from TypeScript source text and flag fork markers.
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";

/** The fork-graph markers a factory-side import must never carry. */
export const FORBIDDEN_FORK_SPECIFIER = /solstice|zeropoint|fork:/i;

/** Every .ts file under dir, recursively, skipping node_modules. */
export function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      out.push(...tsFilesUnder(full));
    } else if (entry.name.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

/** Import specifiers (static, side-effect, dynamic, require) of `source`. */
export function importSpecifiers(source: string): string[] {
  const specs: string[] = [];
  const patterns = [
    /\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']/g,
    /\brequire\s*\(\s*["']([^"']+)["']/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      if (match[1]) specs.push(match[1]);
    }
  }
  return specs;
}

/** `"file: spec"` offenders — files whose import specifiers carry a fork marker. */
export function forkImportOffenders(files: string[], read: (file: string) => string): string[] {
  const offenders: string[] = [];
  for (const file of files) {
    for (const spec of importSpecifiers(read(file))) {
      if (FORBIDDEN_FORK_SPECIFIER.test(spec)) offenders.push(`${file}: ${spec}`);
    }
  }
  return offenders;
}
