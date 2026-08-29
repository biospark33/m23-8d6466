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
 * visualizer/package.json) and the comment in server/auth.ts noting
 * "Bun 1.2.2x" port-validation behavior observed at review time. Recorded
 * honestly below as "unpinned" rather than guessed.
 */

export interface BunApiEntry {
  /** The API as it appears at the call/import site, e.g. "Bun.serve". */
  api: string;
  /**
   * Every repo-relative FILE that really uses this API, sorted and deduped.
   * Files, not "path:line": a line pin rots on any edit above the call and
   * nothing catches it (the header's own `auth.ts:76` had already drifted to
   * `:56`). The inventory test asserts this list against the AST scan, so it
   * is verified data rather than a comment that decays.
   */
  locations: string[];
  /** Lowest Bun version this repo is known to require, or why it's unpinned. */
  minBunVersion: string;
  /** Whether a portable (non-Bun) fallback exists for this usage today. */
  portableFallback: boolean;
}

export const BUN_APIS: BunApiEntry[] = [
  {
    api: "Bun.serve",
    locations: ["visualizer/server/index.ts"],
    minBunVersion: "unpinned (repo floor: @types/bun ^1.1.14; see file header)",
    portableFallback: false,
  },
  {
    api: "Bun.file",
    locations: ["visualizer/server/index.ts"],
    minBunVersion: "unpinned (repo floor: @types/bun ^1.1.14; see file header)",
    portableFallback: false,
  },
  {
    api: "Bun.argv",
    locations: ["visualizer/server/db.ts"],
    minBunVersion: "unpinned (repo floor: @types/bun ^1.1.14; see file header)",
    portableFallback: true,
  },
  {
    api: "bun:sqlite",
    locations: ["visualizer/server/db.ts"],
    minBunVersion: "unpinned (repo floor: @types/bun ^1.1.14; see file header)",
    portableFallback: false,
  },
  {
    api: "import.meta.dir",
    locations: ["visualizer/scripts/check-lcov.ts", "visualizer/server/index.ts"],
    minBunVersion: "unpinned (repo floor: @types/bun ^1.1.14; see file header)",
    portableFallback: true,
  },
  {
    api: "import.meta.main",
    locations: ["visualizer/scripts/check-lcov.ts", "visualizer/server/index.ts"],
    minBunVersion: "unpinned (repo floor: @types/bun ^1.1.14; see file header)",
    portableFallback: true,
  },
];
