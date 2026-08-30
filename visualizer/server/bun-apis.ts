/**
 * DF4.2 AC2: the Bun-only runtime surface, declared exhaustively.
 *
 * Data only — no scanning logic lives here (see test/bun-api-inventory.test.ts
 * for the scanner and comment/type-position exclusion rules), because the
 * scanner excludes this file from its own scan: if the scan logic also lived
 * here, a string literal naming an API would double as "usage" of it, and a
 * stale entry could never be caught.
 *
 * `minBunVersion` is not pinned anywhere in this repo — no .tool-versions,
 * no package.json `engines`, and `.github/workflows/ci.yml` uses
 * `oven-sh/setup-bun@v2` with no `bun-version:` input (installs latest).
 * The only concrete floor in the repo is `@types/bun` (^1.1.14 in
 * visualizer/package.json) and the comment in server/auth.ts:76 noting
 * "Bun 1.2.2x" port-validation behavior observed at review time. Recorded
 * honestly below as "unpinned" rather than guessed.
 */

export interface BunApiEntry {
  /** The API as it appears at the call/import site, e.g. "Bun.serve". */
  api: string;
  /** Every "path:line" (repo-relative) where this API is really used. */
  locations: string[];
  /** Lowest Bun version this repo is known to require, or why it's unpinned. */
  minBunVersion: string;
  /** Whether a portable (non-Bun) fallback exists for this usage today. */
  portableFallback: boolean;
}

export const BUN_APIS: BunApiEntry[] = [
  {
    api: "Bun.serve",
    locations: ["visualizer/server/index.ts:75"],
    minBunVersion: "unpinned (repo floor: @types/bun ^1.1.14; see file header)",
    portableFallback: false,
  },
  {
    api: "Bun.file",
    locations: ["visualizer/server/index.ts:207", "visualizer/server/index.ts:220"],
    minBunVersion: "unpinned (repo floor: @types/bun ^1.1.14; see file header)",
    portableFallback: false,
  },
  {
    api: "Bun.argv",
    locations: ["visualizer/server/db.ts:80"],
    minBunVersion: "unpinned (repo floor: @types/bun ^1.1.14; see file header)",
    portableFallback: true,
  },
  {
    api: "bun:sqlite",
    locations: ["visualizer/server/db.ts:18"],
    minBunVersion: "unpinned (repo floor: @types/bun ^1.1.14; see file header)",
    portableFallback: false,
  },
  {
    api: "import.meta.dir",
    locations: ["visualizer/server/index.ts:33", "visualizer/scripts/check-lcov.ts:161"],
    minBunVersion: "unpinned (repo floor: @types/bun ^1.1.14; see file header)",
    portableFallback: true,
  },
  {
    api: "import.meta.main",
    locations: ["visualizer/server/index.ts:582", "visualizer/scripts/check-lcov.ts:160"],
    minBunVersion: "unpinned (repo floor: @types/bun ^1.1.14; see file header)",
    portableFallback: true,
  },
];
