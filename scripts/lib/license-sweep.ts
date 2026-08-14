/**
 * License sweep for the QDS-Factory enterprise OCI image (story DF2.9).
 *
 * The enterprise tier redistributes pi (`@mariozechner/*`) and the vendored
 * coms substrate inside an image that runs in a client VPC. Finding F13
 * cleared that redistribution subject to conditions; this module encodes them
 * as a build step rather than a hand-maintained list:
 *
 *   1. Walk the ACTUAL post-build `node_modules` tree (never a fixture, never
 *      a transcribed list — the observed set shifts with `--omit=optional`
 *      and provider selection).
 *   2. Classify every package: DENIED (forbidden name), COVERED (ships its
 *      own license text), UNCOVERED (ships none — must land in NOTICE), or
 *      UNRESOLVED (no license metadata and no text — fail closed, INV-4).
 *   3. Resolve a canonical license text for every SPDX identifier observed,
 *      from `oci/license-texts/`. An identifier with no checked-in text is a
 *      fatal error BEFORE NOTICE generation, never a silent omission (INV-4).
 *
 * The caller (`scripts/generate-notice.ts`) owns process exit codes and the
 * ordering guarantee that the denylist runs before anything is generated or
 * tagged (INV-2). This module is pure-ish: it reads the filesystem and
 * returns data; it never exits, never writes, and never touches the network.
 *
 * Why no registry probe: the sweep reads licenses from the installed tree,
 * which is the artifact being shipped. The registry has already had its say
 * during `npm install`, which fails closed when it is unreachable. A probe
 * here would gate nothing.
 */
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Forbidden at any depth, unconditionally, because neither can be remediated
 * by attribution: `@mariozechner/pi-proxy` publishes no license across any of
 * its versions, and `@mariozechner/pi` is a different project entirely (a
 * vLLM pods CLI) that would ship under a false provenance.
 */
export const DENIED_PACKAGES: readonly string[] = ["@mariozechner/pi", "@mariozechner/pi-proxy"];

/** The version F6 proved end to end and `pi-vs-claude-code-vendor` peer-pins. */
export const PI_CODING_AGENT_PIN = "0.55.0";

/** pi libs float inside the coding agent's minor line; anything else is a pin break. */
const PI_LIB_PACKAGES: readonly string[] = [
  "@mariozechner/pi-agent-core",
  "@mariozechner/pi-ai",
  "@mariozechner/pi-tui",
];
const PI_LIB_RANGE = /^0\.55\.\d/;

/**
 * Dropped by `--omit=optional`. No authoritative license text exists anywhere
 * in its chain (fork and parent repo are both unlicensed) and it is
 * display-gated, so a headless VPC container never loads it. Its presence
 * means the install flags did not take effect.
 */
const CLIPBOARD_PREFIX = "@mariozechner/clipboard";

/** Identifiers common enough that listing them would be noise, not disclosure. */
const FAMILIAR_IDS = new Set(["MIT", "Apache-2.0", "ISC", "BSD-2-Clause", "BSD-3-Clause", "0BSD"]);

/**
 * Copyright holders that package metadata does not carry but an authoritative
 * upstream LICENSE does. Used verbatim in NOTICE; the alternative is either a
 * weaker attribution or a fabricated year.
 */
const COPYRIGHT_OVERRIDES: Record<string, string> = {
  // pi monorepo root LICENSE (earendil-works/pi) — the per-package tarballs
  // ship no LICENSE file of their own.
  "@mariozechner/pi-coding-agent": "Copyright (c) 2025 Mario Zechner",
  "@mariozechner/pi-agent-core": "Copyright (c) 2025 Mario Zechner",
  "@mariozechner/pi-ai": "Copyright (c) 2025 Mario Zechner",
  "@mariozechner/pi-tui": "Copyright (c) 2025 Mario Zechner",
};

const LICENSE_FILE = /^(licen[cs]e|copying)([._-][\w.-]*)?$/i;
const NOTICE_FILE = /^notice([._-][\w.-]*)?$/i;
/**
 * `license.js`, `notice.ts`, `copying.py` are SOURCE FILES, not license text —
 * several real npm packages ship one. Counting them as shipped license text
 * would classify such a package as covered and drop it from NOTICE with no
 * attribution at all (INV-1), and in the NOTICE-propagation path it would
 * paste JavaScript verbatim into a legal document.
 */
const NON_TEXT_EXT = /\.(js|cjs|mjs|jsx|ts|tsx|mts|cts|json|map|node|wasm|py|rb|go|rs|sh|c|h|css|html|lock)$/i;

function isLicenseText(file: string): boolean {
  return LICENSE_FILE.test(file) && !NON_TEXT_EXT.test(file);
}

function isNoticeText(file: string): boolean {
  return NOTICE_FILE.test(file) && !NON_TEXT_EXT.test(file);
}

export interface PackageEntry {
  name: string;
  version: string;
  /** Absolute path to the package directory in the swept tree. */
  dir: string;
  /** `a > b > c` — how this package is reached from the tree root. */
  depPath: string;
  /** Raw SPDX-ish identifier from package.json, or null when absent/unusable. */
  licenseId: string | null;
  /** Author name, when package.json carries one. */
  author: string | null;
  /** Basenames of NON-EMPTY license text files shipped by the package. */
  licenseFiles: string[];
  /** Basenames of NON-EMPTY upstream NOTICE files shipped by the package. */
  noticeFiles: string[];
}

export interface IdPackages {
  id: string;
  packages: string[];
}

export interface WalkResult {
  entries: PackageEntry[];
  /** Manifests/directories the walk could not read (INV-4 fail-closed input). */
  unreadable: string[];
}

/** An upstream NOTICE file found in the tree, to be propagated verbatim. */
export interface UpstreamNotice {
  /** `name@version` of the package that ships it. */
  pkg: string;
  dir: string;
  file: string;
}

export interface SweepResult {
  treePackageCount: number;
  entries: PackageEntry[];
  denied: PackageEntry[];
  covered: PackageEntry[];
  uncovered: PackageEntry[];
  /** No license metadata AND no shipped text — fail closed (INV-4). */
  unresolved: PackageEntry[];
  /** Observed identifiers with no canonical text checked in (INV-4). */
  missingTexts: IdPackages[];
  /** Every upstream NOTICE file in the tree (INV-3), from any copy. */
  upstreamNotices: UpstreamNotice[];
  /** Package dirs the walk could not read — fail closed rather than skip. */
  unreadable: string[];
  /** Version-pin breaks (AC2), each naming the observed version. */
  pinViolations: string[];
  piVersions: Record<string, string>;
  /** Permissive-but-less-common identifiers, disclosed to reviewers. */
  uncommonIds: IdPackages[];
  /** Resolved canonical text per observed identifier. */
  licenseTexts: Record<string, string>;
}

export interface SweepOptions {
  /** A package root or a `node_modules` directory. */
  treeRoot: string;
  /** Directory of canonical license texts, one `<SPDX-id>.txt` per identifier. */
  licenseTextsDir: string;
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** True when `file` exists, is a regular file, and holds at least one byte. */
function nonEmptyFile(file: string): boolean {
  try {
    const st = fs.statSync(file);
    return st.isFile() && st.size > 0;
  } catch {
    return false;
  }
}

function authorName(pkg: Record<string, unknown>): string | null {
  const a = pkg.author;
  if (typeof a === "string" && a.trim()) {
    // "Name <email> (url)" — keep the name, drop the contact details.
    return a.replace(/[<(].*$/, "").trim() || null;
  }
  if (a !== null && typeof a === "object" && !Array.isArray(a)) {
    const n = (a as Record<string, unknown>).name;
    if (typeof n === "string" && n.trim()) return n.trim();
  }
  return null;
}

/**
 * The SPDX identifier a package declares, across every shape npm has ever
 * accepted. Returns null for "no usable identifier" — including `UNLICENSED`
 * and `SEE LICENSE IN <file>`, which name no license the sweep can reproduce.
 */
export function readLicenseId(pkg: Record<string, unknown>): string | null {
  const clean = (v: unknown): string | null => {
    if (typeof v !== "string") return null;
    const s = v.trim();
    if (!s || /^unlicensed$/i.test(s) || /^see licen[cs]e in\b/i.test(s)) return null;
    return s;
  };
  const lic = pkg.license;
  if (typeof lic === "string") return clean(lic);
  if (lic !== null && typeof lic === "object" && !Array.isArray(lic)) {
    return clean((lic as Record<string, unknown>).type);
  }
  const legacy = pkg.licenses;
  if (Array.isArray(legacy)) {
    const types = legacy
      .map((l) => (typeof l === "string" ? clean(l) : clean((l as Record<string, unknown>)?.type)))
      .filter((t): t is string => t !== null);
    if (types.length === 1) return types[0]!;
    if (types.length > 1) return `(${types.join(" OR ")})`;
  }
  return null;
}

/**
 * Every package in the tree, depth-first, with its dependency path. Accepts
 * either a package root (whose `node_modules` is walked) or a `node_modules`
 * directory itself. Throws when no tree is there — an absent tree must never
 * read as a vacuously clean sweep.
 */
export function walkTree(treeRoot: string): WalkResult {
  const nm = path.basename(treeRoot) === "node_modules" ? treeRoot : path.join(treeRoot, "node_modules");
  if (!fs.existsSync(nm) || !fs.statSync(nm).isDirectory()) {
    throw new Error(`no dependency tree at ${nm} — nothing to sweep`);
  }
  const entries: PackageEntry[] = [];
  // A directory the walk cannot read is NOT a directory with nothing in it.
  // Skipping it silently would drop a package — and everything nested under
  // it — from the sweep and still call the result clean.
  const unreadable: string[] = [];
  // npm links workspaces and bins as symlinks; a realpath guard keeps a cyclic
  // link from turning the walk into an infinite descent.
  const seenDirs = new Set<string>();

  const visitNodeModules = (dir: string, chain: readonly string[]): void => {
    let real: string;
    try {
      real = fs.realpathSync(dir);
    } catch {
      unreadable.push(dir);
      return;
    }
    if (seenDirs.has(real)) return;
    seenDirs.add(real);

    let listing: fs.Dirent[];
    try {
      listing = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      unreadable.push(dir);
      return;
    }
    for (const ent of listing) {
      // `.bin`, `.package-lock.json`, `.cache` — npm bookkeeping, not packages.
      if (ent.name.startsWith(".")) continue;
      const child = path.join(dir, ent.name);
      if (ent.name.startsWith("@")) {
        // Scope directory: one more level down, same chain.
        visitScope(child, chain);
        continue;
      }
      visitPackage(child, chain);
    }
  };

  const visitScope = (dir: string, chain: readonly string[]): void => {
    let listing: fs.Dirent[];
    try {
      listing = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      unreadable.push(dir);
      return;
    }
    for (const ent of listing) {
      if (ent.name.startsWith(".")) continue;
      visitPackage(path.join(dir, ent.name), chain);
    }
  };

  const visitPackage = (dir: string, chain: readonly string[]): void => {
    const manifest = path.join(dir, "package.json");
    const pkg = readJson(manifest);
    if (!pkg) {
      // Reported unconditionally: a corrupt manifest, a manifest-less directory
      // and a dangling symlink (the shape a linked package takes after a
      // `docker cp` onto the host) are all "a thing in node_modules the sweep
      // cannot inspect" — the INV-4 condition. Its own nested tree is still
      // walked, because the packages under it are real.
      unreadable.push(manifest);
      const orphanNested = path.join(dir, "node_modules");
      if (fs.existsSync(orphanNested)) visitNodeModules(orphanNested, [...chain, path.basename(dir)]);
      return;
    }
    const name = typeof pkg.name === "string" && pkg.name ? pkg.name : path.basename(dir);
    const version = typeof pkg.version === "string" && pkg.version ? pkg.version : "0.0.0";
    let files: string[] = [];
    try {
      files = fs.readdirSync(dir);
    } catch {
      // Unlisted files means "we cannot tell whether it ships license text",
      // which is exactly an INV-4 unresolved condition, not "it ships none".
      unreadable.push(dir);
      files = [];
    }
    entries.push({
      name,
      version,
      dir,
      depPath: [...chain, name].join(" > "),
      licenseId: readLicenseId(pkg),
      author: authorName(pkg),
      licenseFiles: files.filter((f) => isLicenseText(f) && nonEmptyFile(path.join(dir, f))).sort(),
      noticeFiles: files.filter((f) => isNoticeText(f) && nonEmptyFile(path.join(dir, f))).sort(),
    });
    const nested = path.join(dir, "node_modules");
    if (fs.existsSync(nested)) visitNodeModules(nested, [...chain, name]);
  };

  visitNodeModules(nm, []);
  entries.sort((a, b) => a.depPath.localeCompare(b.depPath));
  return { entries, unreadable: [...new Set(unreadable)].sort() };
}

/** A parsed SPDX license expression (the `WITH` form is rejected before parsing). */
type LicenseExpr =
  | { readonly kind: "atom"; readonly id: string }
  | { readonly kind: "and"; readonly args: readonly LicenseExpr[] }
  | { readonly kind: "or"; readonly args: readonly LicenseExpr[] };

/**
 * Recursive-descent parser for SPDX license expressions. Precedence matches
 * the SPDX spec — `AND` binds tighter than `OR`, and parentheses override
 * that: `MIT AND (Apache-2.0 OR BSD-2-Clause)` parses as `MIT AND (Apache-2.0
 * OR BSD-2-Clause)`, not as three atoms all individually required. The prior
 * implementation stripped parens and flattened on any AND/OR split, silently
 * discarding grouping. Returns null on anything that doesn't parse cleanly
 * (unbalanced parens, empty atom, trailing tokens) — the caller treats that
 * as unresolvable, same as before.
 */
function parseLicenseExpression(id: string): LicenseExpr | null {
  const tokens = id.match(/\(|\)|[^\s()]+/g);
  if (!tokens || tokens.length === 0) return null;
  let pos = 0;
  const peek = (): string | undefined => tokens[pos];

  const parseAtom = (): LicenseExpr | null => {
    const tok = peek();
    if (tok === undefined || tok === ")" || /^(?:AND|OR)$/i.test(tok)) return null;
    if (tok === "(") {
      pos++;
      const inner = parseOr();
      if (inner === null || peek() !== ")") return null;
      pos++;
      return inner;
    }
    pos++;
    const trimmed = tok.replace(/\+$/, "");
    return trimmed.length === 0 ? null : { kind: "atom", id: trimmed };
  };

  const parseAnd = (): LicenseExpr | null => {
    const first = parseAtom();
    if (first === null) return null;
    const args = [first];
    while (peek() !== undefined && /^AND$/i.test(peek()!)) {
      pos++;
      const rhs = parseAtom();
      if (rhs === null) return null;
      args.push(rhs);
    }
    return args.length === 1 ? args[0]! : { kind: "and", args };
  };

  function parseOr(): LicenseExpr | null {
    const first = parseAnd();
    if (first === null) return null;
    const args = [first];
    while (peek() !== undefined && /^OR$/i.test(peek()!)) {
      pos++;
      const rhs = parseAnd();
      if (rhs === null) return null;
      args.push(rhs);
    }
    return args.length === 1 ? args[0]! : { kind: "or", args };
  }

  const result = parseOr();
  return result !== null && pos === tokens.length ? result : null;
}

/**
 * The canonical text for an identifier, from `dir/<atom>.txt`. A disjunction
 * is satisfied by any atom that has a text (first match wins); a conjunction
 * needs all of its arguments resolved, evaluated recursively so a nested
 * group (e.g. the `OR` inside `MIT AND (Apache-2.0 OR BSD-2-Clause)`) is
 * satisfied on its own terms rather than being flattened into the outer
 * requirement. Returns null when the identifier cannot be covered — the
 * caller turns that into a fatal exit 2 (INV-4), never a partial NOTICE.
 */
export function resolveLicenseText(id: string, dir: string): string | null {
  // `X WITH Y` is a license PLUS an exception, and the exception text is not in
  // the mapping. Resolving it to X's text alone would ship a NOTICE claiming a
  // license the package is not under — the exact mislabelling INV-4 exists to
  // prevent. Fail closed and make a human add the pair deliberately.
  if (/\bWITH\b/i.test(id)) return null;
  const expr = parseLicenseExpression(id);
  if (expr === null) return null;
  // `<id>.txt` is looked up case-insensitively: npm packages really do declare
  // "mit" and "Apache-2.0" for the same license, and checking in a second file
  // per casing would be a worse answer than one lookup that tolerates it.
  let listing: string[];
  try {
    listing = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const byLower = new Map(listing.map((f) => [f.toLowerCase(), f]));

  const textForAtom = (atomId: string): string | null => {
    // Identifiers are path components; reject anything that could escape `dir`.
    if (atomId.includes("/") || atomId.includes("\\") || atomId.includes("..")) return null;
    const actual = byLower.get(`${atomId.toLowerCase()}.txt`);
    const file = actual === undefined ? null : path.join(dir, actual);
    // A whitespace-only text is no license text — treating it as one would
    // emit a NOTICE entry with an identifier and a blank body (AC1).
    if (file === null || !nonEmptyFile(file) || fs.readFileSync(file, "utf8").trim() === "") return null;
    return fs.readFileSync(file, "utf8");
  };

  const resolve = (node: LicenseExpr): string | null => {
    if (node.kind === "atom") return textForAtom(node.id);
    if (node.kind === "or") {
      for (const arg of node.args) {
        const text = resolve(arg);
        if (text !== null) return text;
      }
      return null;
    }
    const parts: string[] = [];
    for (const arg of node.args) {
      const text = resolve(arg);
      if (text === null) return null;
      parts.push(text);
    }
    return parts.join("\n\n");
  };

  return resolve(expr);
}

function key(e: PackageEntry): string {
  return `${e.name}@${e.version}`;
}

/** Dedupes by `name@version`, keeping the shallowest occurrence. */
function dedupe(entries: readonly PackageEntry[]): PackageEntry[] {
  const seen = new Map<string, PackageEntry>();
  for (const e of entries) {
    if (!seen.has(key(e))) seen.set(key(e), e);
  }
  return [...seen.values()].sort((a, b) => key(a).localeCompare(key(b)));
}

function checkPins(entries: readonly PackageEntry[]): string[] {
  const violations: string[] = [];
  for (const e of entries) {
    if (e.name === CLIPBOARD_PREFIX || e.name.startsWith(`${CLIPBOARD_PREFIX}-`)) {
      violations.push(
        `${key(e)} is present at "${e.depPath}" — --omit=optional must drop it (no attributable license text exists in its chain)`,
      );
      continue;
    }
    if (e.name === "@mariozechner/pi-coding-agent" && e.version !== PI_CODING_AGENT_PIN) {
      violations.push(
        `@mariozechner/pi-coding-agent is pinned to ${PI_CODING_AGENT_PIN} but the tree carries ${e.version} at "${e.depPath}"`,
      );
      continue;
    }
    if (PI_LIB_PACKAGES.includes(e.name) && !PI_LIB_RANGE.test(e.version)) {
      violations.push(
        `${e.name} must float inside 0.55.x but the tree carries ${e.version} at "${e.depPath}"`,
      );
    }
  }
  return violations;
}

/** Classifies a whole tree. Reads the filesystem; never exits, never writes. */
export function sweepTree(opts: SweepOptions): SweepResult {
  const { entries, unreadable } = walkTree(opts.treeRoot);
  const denySet = new Set(DENIED_PACKAGES);

  const denied = entries.filter((e) => denySet.has(e.name));
  const allowed = entries.filter((e) => !denySet.has(e.name));

  // Partition AFTER deduping, and let the copy WITHOUT license text win: the
  // same name@version can appear twice in a tree with only one copy shipping
  // its LICENSE (a partial install, a hoisting quirk). The image then contains
  // a copy with no license text, so INV-1 wants it in NOTICE. Partitioning
  // before the dedupe used to put such a package in `covered` AND `uncovered`.
  // Cloned, because the evidence union below mutates the winner and the raw
  // `entries` list must keep describing what is actually on disk.
  const worst = new Map<string, PackageEntry>();
  for (const e of allowed) {
    const prev = worst.get(key(e));
    if (prev === undefined || (prev.licenseFiles.length > 0 && e.licenseFiles.length === 0)) {
      worst.set(key(e), { ...e });
    }
  }
  // The verdict comes from the worst copy, but the EVIDENCE is unioned across
  // every copy: an upstream NOTICE or a declared SPDX id found on any copy is a
  // fact about the package. Taking only the worst copy's record would drop an
  // upstream NOTICE that the image still contains (INV-3), and could send a
  // package to exit 2 as unresolved while a sibling copy names its license.
  const upstreamNotices: UpstreamNotice[] = [];
  for (const e of allowed) {
    const winner = worst.get(key(e))!;
    if (winner.licenseId === null && e.licenseId !== null) winner.licenseId = e.licenseId;
    if (winner.author === null && e.author !== null) winner.author = e.author;
    for (const file of e.noticeFiles) {
      // One entry per package+filename; two installed copies of the same
      // version carry the same bytes.
      if (upstreamNotices.some((n) => n.pkg === key(e) && n.file === file)) continue;
      upstreamNotices.push({ pkg: key(e), dir: e.dir, file });
    }
  }
  upstreamNotices.sort((a, b) => a.pkg.localeCompare(b.pkg) || a.file.localeCompare(b.file));
  const distinct = [...worst.values()].sort((a, b) => key(a).localeCompare(key(b)));
  const covered = distinct.filter((e) => e.licenseFiles.length > 0);
  const rest = distinct.filter((e) => e.licenseFiles.length === 0);
  const uncovered = rest.filter((e) => e.licenseId !== null);
  const unresolved = rest.filter((e) => e.licenseId === null);

  // Every identifier the sweep can see needs a canonical text — including the
  // ones on covered packages, so a future dependency with an exotic license
  // fails the build instead of slipping through on a bundled file alone.
  const idPackages = new Map<string, string[]>();
  for (const e of [...covered, ...uncovered]) {
    if (e.licenseId === null) continue;
    const list = idPackages.get(e.licenseId) ?? [];
    list.push(key(e));
    idPackages.set(e.licenseId, list);
  }

  const missingTexts: IdPackages[] = [];
  const licenseTexts: Record<string, string> = {};
  for (const [id, packages] of [...idPackages.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const text = resolveLicenseText(id, opts.licenseTextsDir);
    if (text === null) missingTexts.push({ id, packages });
    else licenseTexts[id] = text;
  }

  const uncommonIds: IdPackages[] = [...idPackages.entries()]
    .filter(([id]) => !FAMILIAR_IDS.has(id))
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([id, packages]) => ({ id, packages }));

  const piVersions: Record<string, string> = {};
  for (const e of entries) {
    if (!e.name.startsWith("@mariozechner/")) continue;
    const prev = piVersions[e.name];
    if (prev === undefined) piVersions[e.name] = e.version;
    else if (!prev.split(", ").includes(e.version)) piVersions[e.name] = `${prev}, ${e.version}`;
  }

  return {
    treePackageCount: entries.length,
    entries,
    denied,
    covered,
    uncovered,
    unresolved,
    missingTexts,
    upstreamNotices,
    unreadable,
    pinViolations: checkPins(entries),
    piVersions,
    uncommonIds,
    licenseTexts,
  };
}

export interface NoticeMeta {
  imageRef: string;
  installFlags: string;
  sweptAt: string;
}

function copyrightLine(e: PackageEntry): string {
  const override = COPYRIGHT_OVERRIDES[e.name];
  if (override) return override;
  if (e.author) return `Copyright (c) ${e.author}`;
  // No year is invented: package metadata does not carry one, and a fabricated
  // date in an attribution notice is worse than an undated one.
  return `Copyright (c) ${e.name} contributors`;
}

const RULE = "-".repeat(76);

/**
 * Renders the NOTICE. Every uncovered package gets its identifier, its
 * copyright line and the FULL canonical license text for that identifier —
 * Apache-2.0 §4(a) is an affirmative duty to hand every recipient the license,
 * which a copyright line or a URL does not discharge (INV-3). Covered packages
 * appear only when they carry an upstream NOTICE file, whose bytes propagate
 * verbatim.
 */
export function renderNotice(result: SweepResult, meta: NoticeMeta): string {
  const piVersion = result.piVersions["@mariozechner/pi-coding-agent"] ?? "(absent)";
  const out: string[] = [
    "NOTICE — QDS-Factory enterprise image",
    "=====================================",
    "",
    `Image:            ${meta.imageRef}`,
    `Swept at:         ${meta.sweptAt}`,
    `Install flags:    ${meta.installFlags}`,
    `pi-coding-agent:  ${piVersion}`,
    `Packages in tree: ${result.treePackageCount} installed copies`,
    `Distinct packages:  ${result.covered.length} ship their own license text, ${result.uncovered.length} do not`,
    "",
    "Generated by scripts/generate-notice.ts from a sweep of this image's own",
    "dependency tree. Do not edit by hand — the next build overwrites it.",
    "",
  ];

  out.push(
    RULE,
    "Third-party packages that ship no license text of their own",
    RULE,
    "",
  );
  if (result.uncovered.length === 0) {
    out.push("(none observed in this tree)", "");
  }
  for (const e of result.uncovered) {
    const text = e.licenseId === null ? undefined : result.licenseTexts[e.licenseId];
    if (text === undefined || text.trim() === "") {
      // Unreachable through the CLI, which gates on `missingTexts` first — and
      // it stays unreachable for every other caller too. A NOTICE entry with an
      // identifier and no license text is precisely what AC1 forbids, so this
      // renderer refuses to produce one rather than degrading quietly.
      throw new Error(
        `refusing to render ${key(e)}: no canonical license text resolved for "${e.licenseId}"`,
      );
    }
    out.push(
      `### ${key(e)}`,
      `SPDX-License-Identifier: ${e.licenseId}`,
      copyrightLine(e),
      `Dependency path: ${e.depPath}`,
      "",
      text.trimEnd(),
      "",
    );
  }

  // Upstream NOTICE bytes propagate for every copy in the tree that ships one,
  // whether or not that package also ships license text (INV-3).
  if (result.upstreamNotices.length > 0) {
    out.push(RULE, "Upstream NOTICE files (propagated verbatim, Apache-2.0 §4(a))", RULE, "");
    for (const n of result.upstreamNotices) {
      out.push(
        `### ${n.pkg} — ${n.file}`,
        "",
        fs.readFileSync(path.join(n.dir, n.file), "utf8").trimEnd(),
        "",
      );
    }
  }

  const noSpdx = result.covered.filter((e) => e.licenseId === null);
  if (result.uncommonIds.length > 0 || noSpdx.length > 0) {
    out.push(RULE, "Reviewer notes", RULE, "");
    if (result.uncommonIds.length > 0) {
      out.push(
        "Less-common but permissive, OSI-recognized identifiers observed in this tree:",
        "",
      );
      for (const u of result.uncommonIds) {
        out.push(`  ${u.id}: ${u.packages.join(", ")}`);
      }
      out.push("");
    }
    if (noSpdx.length > 0) {
      out.push(
        "Packages that declare no SPDX `license` field but ship their own license",
        "text, by which their attribution obligation is discharged:",
        "",
      );
      for (const e of noSpdx) {
        out.push(`  ${key(e)} (${e.licenseFiles.join(", ")})`);
      }
      out.push("");
    }
  }

  return `${out.join("\n").trimEnd()}\n`;
}

/**
 * The negative control: names every uncovered package the NOTICE fails to
 * mention. A NOTICE transcribed from a static list passes a spot check and
 * fails here the moment the tree moves.
 */
export function verifyNoticeCoverage(notice: string, uncovered: readonly PackageEntry[]): string[] {
  // Line-exact against the `### name@version` heading `renderNotice` emits, not
  // a substring scan of the whole file. The NOTICE body carries upstream bytes
  // and free-text dependency paths, so a substring check could be satisfied by
  // an unrelated mention — `glob@1.2.3` by "fast-glob@1.2.3", `foo@1.2.3` by
  // "foo@1.2.30" — which would blunt the negative control this exists for.
  const headings = new Set(notice.split("\n").map((l) => l.trim()));
  return dedupe(uncovered)
    .map(key)
    .filter((k) => !headings.has(`### ${k}`));
}

export interface SweepSummary {
  imageRef: string;
  treePackageCount: number;
  coveredCount: number;
  uncoveredCount: number;
  deniedHits: string[];
  piVersions: Record<string, string>;
  noticeBytes: number;
  sweptAt: string;
  exitCode: number;
}

/** The one structured record a run emits, per the story's observability contract. */
export function summarize(
  result: SweepResult,
  meta: NoticeMeta,
  noticeBytes: number,
  exitCode: number,
): SweepSummary {
  return {
    imageRef: meta.imageRef,
    treePackageCount: result.treePackageCount,
    coveredCount: result.covered.length,
    uncoveredCount: result.uncovered.length,
    deniedHits: result.denied.map((e) => `${key(e)} @ ${e.depPath}`),
    piVersions: result.piVersions,
    noticeBytes,
    sweptAt: meta.sweptAt,
    exitCode,
  };
}
