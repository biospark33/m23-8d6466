/**
 * Shared pi-lens harness utilities: install resolution, version comparison,
 * on-disk path resolution, and latency statistics.
 *
 * Extracted from `scripts/pi-lens-verify.ts` (P0.5) so that harness and every
 * successor (`scripts/lsp-verify.ts` P0.6, P0.11, P1.7) share one
 * implementation instead of copy-adapting it. Copy-adaptation meant a defect
 * found in review had to be fixed once per harness.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { harnessNotes } from "./harness-notes.ts";

// Re-exported for consumers that already import it from here. The array itself
// lives in a dependency-free module so the MCP transport can record a warning
// without importing anything pi-lens-specific.
export { harnessNotes } from "./harness-notes.ts";

export interface PiLensInstall {
  root: string;
  version: string;
  server: string;
  /** How the install was found — recorded so provisioning is auditable. */
  source: "PI_LENS_ROOT" | "repo-local" | "global";
}

/**
 * Resolve a usable pi-lens install: an explicit `PI_LENS_ROOT` override, then a
 * repo-local `node_modules/pi-lens`, then the global probe. pi-lens is NOT
 * guaranteed to be a host-global install on every machine, so every harness
 * MUST resolve through here — a resolver that skipped the override was the
 * cause of `pi-lens-verify` fatalling on hosts where `PI_LENS_ROOT` was the
 * only install (#55).
 *
 * Throws when no install resolves.
 */
/**
 * Read `version` out of a package.json, throwing when it is absent or not a
 * string. Both resolvers call this inside a try that skips the candidate, so a
 * version-less package.json is treated exactly like an unreadable one — the
 * `as string` cast alone let `undefined` through and only blew up later, inside
 * `compareVersions`.
 */
function readPkgVersion(pkgPath: string): string {
  const version = JSON.parse(fs.readFileSync(pkgPath, "utf8")).version;
  if (typeof version !== "string" || version === "") {
    throw new Error(`missing or non-string "version" in ${pkgPath}`);
  }
  return version;
}

export function resolvePiLens(repoRoot: string): PiLensInstall {
  const direct: Array<{ root: string; source: PiLensInstall["source"] }> = [];
  const override = process.env.PI_LENS_ROOT?.trim();
  if (override) direct.push({ root: override, source: "PI_LENS_ROOT" });
  direct.push({ root: path.join(repoRoot, "node_modules", "pi-lens"), source: "repo-local" });

  for (const cand of direct) {
    const pkgPath = path.join(cand.root, "package.json");
    const server = path.join(cand.root, "dist", "mcp", "server.js");
    if (!fs.existsSync(pkgPath) || !fs.existsSync(server)) continue;
    try {
      return { root: cand.root, version: readPkgVersion(pkgPath), server, source: cand.source };
    } catch {
      /* unreadable or version-less package.json — fall through to the next candidate */
    }
  }
  return resolveGlobalPiLens();
}

/**
 * Resolve the installed pi-lens package root + version from the global npm dir.
 * Throws when pi-lens is not installed in any known global location.
 *
 * Prefer `resolvePiLens()` — this is only its last step.
 */
export function resolveGlobalPiLens(): PiLensInstall {
  // pi installs npm:pi-lens into the node used by pi. Probe the known global
  // dirs first, then fall back to `npm root -g`.
  const candidates = [
    path.join(os.homedir(), ".local", "node-arm64", "lib", "node_modules", "pi-lens"),
    path.join(os.homedir(), ".local", "node-x64", "lib", "node_modules", "pi-lens"),
  ];
  try {
    // Bounded, like every other external call in these harnesses: an
    // unbounded probe lets a wedged/network-stalled npm hang startup forever.
    const g = execFileSync("npm", ["root", "-g"], { encoding: "utf8", timeout: 10_000 }).trim();
    candidates.push(path.join(g, "pi-lens"));
  } catch {
    /* npm unavailable or too slow — probe the known dirs only */
  }
  // Collect EVERY resolvable install so multiple divergent versions are visible
  // instead of silently picking the first.
  const found: Array<{ root: string; version: string }> = [];
  for (const c of candidates) {
    const pkgPath = path.join(c, "package.json");
    if (found.some((f) => f.root === c) || !fs.existsSync(pkgPath)) continue;
    try {
      found.push({ root: c, version: readPkgVersion(pkgPath) });
    } catch {
      /* unreadable or version-less package.json — skip this candidate */
    }
  }
  const primary = found.find((f) => fs.existsSync(path.join(f.root, "dist", "mcp", "server.js")));
  if (!primary) throw new Error("pi-lens not found in any known global node_modules dir");
  const divergent = found.filter((f) => f.version !== primary.version);
  if (divergent.length > 0) {
    harnessNotes.push(
      `multiple pi-lens installs with divergent versions: using ${primary.root}@${primary.version}; also found ${divergent
        .map((f) => `${f.root}@${f.version}`)
        .join(", ")}`,
    );
  }
  return {
    root: primary.root,
    version: primary.version,
    server: path.join(primary.root, "dist", "mcp", "server.js"),
    source: "global",
  };
}

/**
 * Semver-ish compare for dotted versions; returns -1 when a < b.
 *
 * Pre-release suffixes are handled explicitly rather than left to `parseInt`'s
 * permissive parsing: `parseInt("69-rc", 10)` is `69`, which would rank
 * `3.8.69-rc.0` as EQUAL to the `3.8.69` release and let a pre-release silently
 * satisfy a version floor. Per semver a pre-release sorts BELOW its release,
 * and two pre-releases of the same core compare by identifier.
 */
export function compareVersions(a: string, b: string): number {
  const split = (v: string): { nums: number[]; prerelease: string | null } => {
    const dash = v.indexOf("-");
    const core = dash >= 0 ? v.slice(0, dash) : v;
    return {
      nums: core.split(".").map((n) => Number.parseInt(n, 10) || 0),
      prerelease: dash >= 0 ? v.slice(dash + 1) : null,
    };
  };
  const pa = split(a);
  const pb = split(b);
  for (let i = 0; i < Math.max(pa.nums.length, pb.nums.length); i++) {
    const d = (pa.nums[i] ?? 0) - (pb.nums[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  // Equal cores: a pre-release ranks below the plain release.
  if (pa.prerelease === null && pb.prerelease === null) return 0;
  if (pa.prerelease !== null && pb.prerelease === null) return -1;
  if (pa.prerelease === null && pb.prerelease !== null) return 1;
  // Both pre-releases: compare dot-separated identifiers per semver §11 —
  // numerically when both are numeric (so rc.9 < rc.10, which a lexical or
  // locale-sensitive compare gets backwards), lexically otherwise, with a
  // numeric identifier ranking below a non-numeric one. A shorter identifier
  // list sorts lower when all shared identifiers are equal.
  const ia = (pa.prerelease as string).split(".");
  const ib = (pb.prerelease as string).split(".");
  for (let i = 0; i < Math.max(ia.length, ib.length); i++) {
    const x = ia[i];
    const y = ib[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xNum = /^\d+$/.test(x);
    const yNum = /^\d+$/.test(y);
    if (xNum && yNum) {
      const d = Number(x) - Number(y);
      if (d !== 0) return d < 0 ? -1 : 1;
    } else if (xNum !== yNum) {
      return xNum ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/**
 * Resolve pi-lens's on-disk project data dir for a given cwd, mirroring
 * `dist/clients/file-utils.js`. pi-lens is project-scoped
 * (`~/.pi-lens/projects/<slug>/`), NOT the flat `~/.pi-lens/cache/`.
 */
export function projectDataDir(cwd: string): string {
  const legacy = path.join(cwd, ".pi-lens");
  const configured = process.env.PILENS_DATA_DIR?.trim();
  if (!configured && fs.existsSync(legacy)) return legacy;
  const base = configured || path.join(os.homedir(), ".pi-lens", "projects");
  const slug = path
    .resolve(cwd)
    .replace(/^[a-z]:/i, "")
    .replace(/\/+/g, "-")
    .replace(/[^A-Za-z0-9-]/g, "")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  return path.join(base.trim(), slug || "default");
}

/** p95 by nearest-rank over a numeric sample set. Undefined when empty. */
export function p95(samples: readonly number[]): number | undefined {
  if (samples.length === 0) return undefined;
  const sorted = [...samples].sort((a, b) => a - b);
  // Nearest-rank: ceil(0.95 * N), 1-indexed, clamped into range.
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil(0.95 * sorted.length)));
  return sorted[rank - 1];
}

/**
 * Absolute + symlink-resolved path, for comparing a location against a
 * worktree root. Symlink resolution matters on macOS, where `os.tmpdir()`
 * hands back `/var/folders/...` while a language server reports the real
 * `/private/var/folders/...` for the SAME file — a raw prefix compare would
 * then mislabel every in-worktree path as external. When the target does not
 * exist, the nearest existing ancestor is resolved and the remainder
 * re-appended, so one side of a comparison can never be canonicalized while
 * the other is not.
 */
export function canonicalize(p: string): string {
  const abs = path.resolve(p);
  try {
    return fs.realpathSync.native(abs);
  } catch {
    /* target does not exist — resolve the nearest existing ancestor instead */
  }
  let dir = path.dirname(abs);
  const tail: string[] = [path.basename(abs)];
  while (dir !== path.dirname(dir)) {
    try {
      return path.join(fs.realpathSync.native(dir), ...tail.reverse());
    } catch {
      tail.push(path.basename(dir));
      dir = path.dirname(dir);
    }
  }
  return abs;
}

/**
 * Separator-aware containment: `/w/lib.ts` is inside `/w`, but the sibling
 * `/w-other/lib.ts` is NOT — a bare `startsWith` would call it a false local.
 * The root itself counts as inside.
 */
export function isInside(child: string, root: string): boolean {
  if (child === root) return true;
  return child.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
}
