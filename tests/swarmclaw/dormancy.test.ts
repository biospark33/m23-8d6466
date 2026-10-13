/**
 * Z5 chassis-fate dormancy guard — story AC4, interface I4, stated inline
 * (self-contained). The swarmclaw chassis is dormant-but-retained (DD-18):
 * the structured logger lives at `src/lib/log.ts` (z5 I1 — the origin
 * `src/swarmclaw/log.ts` is DELETED, no shim anywhere), `maskEnv` lives at
 * `src/lib/mask-env.ts` (z5 I2 — the copy on
 * `src/swarmclaw/mcp/tool-bridge.ts` is severed), the server surface
 * (`createServer`, `routes/*`, `store/*`) is retained behind the
 * `src/index.ts` re-export barrel, and `stdio-transport` exports no log
 * symbols (its own header: "logMuted is deliberately absent"). This guard
 * fails — naming the offending file paths — if any of the four rules below
 * regresses.
 *
 * Scope: rules 1, 2, and 4 bind EVERYWHERE the guard walks — the production
 * trees `src/`, `scripts/`, `visualizer/` AND `tests/` (this file's own
 * plants are in-memory strings, invisible to a specifier parser). Rule 3 is
 * PRODUCTION-ONLY: fixture tests legitimately wire the retained surface
 * (tests/swarmclaw/index.test.ts imports createServer by design), so
 * `tests/` is exempt from rule 3 alone. visualizer's own test files
 * (visualizer/test/) are production files and have been walked all along.
 *
 * Four dormancy rules. Every rule matches a specifier two ways — by path
 * TAIL (location-independent, which is what lets the synthetic controls
 * fire from os.tmpdir()) or by resolving it against the importing file
 * (which pins the exact repo paths):
 *   1. log-origin: specifier tails `swarmclaw/log[.<ext>]` (`.d.ts`
 *      included — declaration-file resurrection) or resolves to
 *      `src/swarmclaw/log.ts`, or anywhere under `src/swarmclaw/log/`
 *      (index-barrel resurrection);
 *   2. maskEnv severance: specifier targets
 *      `.../swarmclaw/mcp/tool-bridge.ts` and the clause names `maskEnv`
 *      OR is a star/namespace clause (`export *`, `import * as`) — the
 *      binding can reach the fenced symbol without naming it;
 *   3. retained server surface (AC4 clause (a)): a module OUTSIDE
 *      `src/swarmclaw/` — with `src/index.ts` excepted, and ONLY for this
 *      rule — whose edge resolves into `src/swarmclaw/` with a clause
 *      naming `createServer`, or resolves under `src/swarmclaw/routes/`
 *      or `src/swarmclaw/store/`. Subtree-internal wiring is unbound.
 *   4. log-via-transport: specifier targets
 *      `.../swarmclaw/mcp/stdio-transport` and the clause names
 *      `log|logMuted|logSink|setLogSink|newRequestId|LogEntry` OR is a
 *      star/namespace clause — the restored-re-export regression, bound
 *      for every importer.
 * For dynamic `import()`/`require()` edges the clause is the ENCLOSING
 * declaration: a balanced-brace walk back to the binding and forward to
 * the statement's closing `;`, so a multiline destructuring flags exactly
 * like its single-line form.
 *
 * Parsing mechanics, stated exactly. Import edges are read by two passes
 * whose UNION is scanned: a line-anchored pass over the raw text, and a
 * pass over a position-preserving comment-stripped copy (one string-span
 * set serves both, since indices are identical). Consequences:
 *   - an import at TRUE line start inside a block comment or template
 *     literal is code-shaped to the raw pass and IS flagged — coherent,
 *     since the raw text then contains the dead path, which is already an
 *     AC3 zero-mentions violation;
 *   - house `//` and JSDoc ` * ` comment forms are invisible to the
 *     stripped pass and never start an edge for the raw pass;
 *   - a dynamic/require match whose `import(`/`require(` sits inside a
 *     STRING literal interior is planted text, not an edge, and is skipped
 *     (this is what keeps test files that embed code fragments clean);
 *   - a quote inside a regex literal can confuse the stripper's string
 *     tracking; harmless here (stripping only blanks comment characters
 *     and copies strings verbatim), and the raw pass still catches any
 *     real import after such a decoy;
 *   - template-literal ceiling: a specifier is scanned as its static
 *     text, so a plain `` import(`../x.ts`) `` is caught while an
 *     interpolated `` import(`../x/${f}.ts`) `` is not (a computed
 *     specifier cannot be resolved statically).
 *
 * Built-in controls: a NEGATIVE control plants violations in a synthetic
 * tree under os.tmpdir() (never a real repo file) and must FAIL naming the
 * offending paths in the guard's formatted message; a POSITIVE control
 * holds the barrel exemption open for clause (a) ONLY — violating content
 * under the barrel's exact path still flags for rules 1, 2, and 4 — while
 * proving the exemption narrow (the same content under any other path is
 * flagged).
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

// ---------------------------------------------------------------------------
// The guard
// ---------------------------------------------------------------------------

const ROOT = join(import.meta.dir, "..", "..");
const RESOLVED_LOG = join(ROOT, "src", "swarmclaw", "log.ts");
const RESOLVED_LOG_DIR = join(ROOT, "src", "swarmclaw", "log");
const RESOLVED_TOOL_BRIDGE = join(ROOT, "src", "swarmclaw", "mcp", "tool-bridge.ts");
const RESOLVED_TRANSPORT = join(ROOT, "src", "swarmclaw", "mcp", "stdio-transport.ts");
const SWARMCLAW_DIR = join(ROOT, "src", "swarmclaw");
const SWARMCLAW_ROUTES = join(SWARMCLAW_DIR, "routes");
const SWARMCLAW_STORE = join(SWARMCLAW_DIR, "store");
/** Exempt for rule 3 ONLY: rules 1, 2, and 4 bind the barrel like anyone else. */
const EXEMPT_BARREL = "src/index.ts";

/** Rule 3 walks the production trees; rules 1/2/4 additionally walk tests/. */
type ScanScope = "production" | "tests";

type DormancyKind =
  | "log-origin-import"
  | "maskenv-from-tool-bridge"
  | "server-surface-import"
  | "log-via-transport";

interface DormancyViolation {
  file: string;
  line: number;
  kind: DormancyKind;
  specifier: string;
}

/** The guard's formatted failure message — what AC4 means by "naming the
 * offending file paths". Asserted directly by the negative controls. */
function formatViolation(v: DormancyViolation): string {
  return `${v.file}:${v.line}: [${v.kind}] imports "${v.specifier}" — z5 AC4 dormancy: this fenced path must stay unwired`;
}

/**
 * Static import edges: import-from AND export-from (a re-export is an import
 * edge; index.ts surfaces are export-from only). The `(?:^|[\n;])` anchor is
 * the comment defence for house-formatted comments — a `//` or ` * ` prefixed
 * line never starts with import/export. The clause excludes quotes, so the
 * match cannot leak past the statement.
 */
const STATIC_EDGE =
  /(?:^|[\n;])[ \t]*(?:import|export)\b(?<clause>[^"';]*?)\bfrom\b[ \t]*(?<q>["'])(?<spec>[^"']+)\k<q>/g;
/** Bare side-effect imports: `import "./x.ts";` */
const SIDE_EFFECT = /(?:^|[\n;])[ \t]*import[ \t]*(?<q>["'])(?<spec>[^"']+)\k<q>/g;
/** Dynamic imports, including type-position `import("...").T`. */
const DYNAMIC = /\bimport[ \t]*\([ \t]*(?<q>["'`])(?<spec>[^"'`]+)\k<q>/g;
/** require() — unused in src/ and scripts/ today, kept so the guard survives it. */
const REQUIRE = /\brequire[ \t]*\([ \t]*(?<q>["'`])(?<spec>[^"'`]+)\k<q>/g;

/** Path tails: the dead origin (`.d.ts` = declaration-file resurrection), the
 * severed bridge, the restored-re-export regression, and clause (a) targets. */
const LOG_TAIL = /(?:^|\/)swarmclaw\/log(?:\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|d\.ts))?$/;
const BRIDGE_TAIL = /(?:^|\/)swarmclaw\/mcp\/tool-bridge(?:\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs))?$/;
const TRANSPORT_TAIL = /(?:^|\/)swarmclaw\/mcp\/stdio-transport(?:\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs))?$/;
const SWARMCLAW_DIR_TAIL = /(?:^|\/)swarmclaw\//;
const SWARMCLAW_ROUTES_TAIL = /(?:^|\/)swarmclaw\/routes\//;
const SWARMCLAW_STORE_TAIL = /(?:^|\/)swarmclaw\/store\//;
/** The retained-surface subtree, relative to the repo root. */
const REL_SWARMCLAW = "src/swarmclaw/";
/** Rule 4's restored-re-export symbols (word-bounded), logMuted included:
 * stdio-transport's header asserts logMuted is deliberately absent — the
 * guard enforces that claim. */
const LOG_CLAUSE = /\b(?:log|logMuted|logSink|setLogSink|newRequestId|LogEntry)\b/;
/** Star/namespace clauses reach fenced symbols without naming them. */
const STAR_CLAUSE = /^\s*\*/;

interface LexView {
  text: string;
  stringSpans: Array<[number, number]>;
}

/**
 * POSITION-PRESERVING lexer: deleted comment characters are replaced
 * one-for-one with spaces, so indices in the stripped text equal indices in
 * the raw source and ONE string-span set serves both views. String interiors
 * are copied verbatim and recorded as spans (a dynamic/require match inside
 * a string interior is planted text, not an edge). Newlines always preserved.
 */
function lexSource(source: string): LexView {
  type Mode = "code" | "line" | "block" | "'" | '"' | "`";
  let out = "";
  const stringSpans: Array<[number, number]> = [];
  let mode: Mode = "code";
  let spanStart = -1;
  let i = 0;
  while (i < source.length) {
    const c = source[i]!;
    const d = source[i + 1] ?? ""; // dp:ok EOF sentinel — "" is the defined no-lookahead value at end of input, not a blanked validation failure
    if (mode === "code") {
      if (c === "/" && d === "/") {
        mode = "line";
        out += "  ";
        i += 2;
      } else if (c === "/" && d === "*") {
        mode = "block";
        out += "  ";
        i += 2;
      } else if (c === "'" || c === '"' || c === "`") {
        mode = c;
        spanStart = i;
        out += c;
        i += 1;
      } else {
        out += c;
        i += 1;
      }
      continue;
    }
    if (mode === "line") {
      if (c === "\n") {
        mode = "code";
        out += "\n";
      } else {
        out += " ";
      }
      i += 1;
      continue;
    }
    if (mode === "block") {
      if (c === "*" && d === "/") {
        mode = "code";
        out += "  ";
        i += 2;
      } else {
        out += c === "\n" ? "\n" : " ";
        i += 1;
      }
      continue;
    }
    // Inside a string/template: copy verbatim; escapes keep the literal intact.
    if (c === "\\") {
      out += c + d;
      i += 2;
      continue;
    }
    if (c === mode) {
      stringSpans.push([spanStart, i + 1]);
      mode = "code";
    }
    out += c;
    i += 1;
  }
  if (mode !== "code" && mode !== "line" && mode !== "block") {
    stringSpans.push([spanStart, source.length]);
  }
  return { text: out, stringSpans };
}

function inStringSpan(spans: ReadonlyArray<readonly [number, number]>, index: number): boolean {
  return spans.some(([a, b]) => index >= a && index < b);
}

function isUnder(path: string, dir: string): boolean {
  return path === dir || path.startsWith(`${dir}${sep}`);
}

/** Clause (a) binds only outsiders: modules not under the retained subtree. */
function isOutsideSwarmclaw(file: string): boolean {
  return !relFromRoot(file).startsWith(REL_SWARMCLAW);
}

/**
 * The four dormancy rules. Tail tests work on the specifier's normalized
 * path tail (location-independent, so synthetic controls fire from
 * os.tmpdir()); resolved tests pin the exact repo paths (so a contorted
 * specifier like `../swarmclaw/mcp/../mcp/tool-bridge.ts` is still caught
 * inside the repo). The barrel exemption applies to rule 3 ONLY — rules 1,
 * 2, and 4 bind `src/index.ts` like any other module, in any scope.
 */
function classifyEdge(importingFile: string, clause: string, specifier: string, scope: ScanScope): DormancyKind | null {
  const norm = specifier.split("\\").join("/");
  const resolved = isAbsolute(specifier) ? resolve(specifier) : resolve(dirname(importingFile), specifier);
  if (LOG_TAIL.test(norm) || resolved === RESOLVED_LOG || isUnder(resolved, RESOLVED_LOG_DIR)) {
    return "log-origin-import";
  }
  const starClause = STAR_CLAUSE.test(clause);
  if ((BRIDGE_TAIL.test(norm) || resolved === RESOLVED_TOOL_BRIDGE) && (/\bmaskEnv\b/.test(clause) || starClause)) {
    return "maskenv-from-tool-bridge";
  }
  if (scope === "production" && isOutsideSwarmclaw(importingFile) && relFromRoot(importingFile) !== EXEMPT_BARREL) {
    const intoSwarmclaw = SWARMCLAW_DIR_TAIL.test(norm) || isUnder(resolved, SWARMCLAW_DIR);
    const underRoutes = SWARMCLAW_ROUTES_TAIL.test(norm) || isUnder(resolved, SWARMCLAW_ROUTES);
    const underStore = SWARMCLAW_STORE_TAIL.test(norm) || isUnder(resolved, SWARMCLAW_STORE);
    if ((intoSwarmclaw && /\bcreateServer\b/.test(clause)) || underRoutes || underStore) {
      return "server-surface-import";
    }
  }
  if ((TRANSPORT_TAIL.test(norm) || resolved === RESOLVED_TRANSPORT) && (LOG_CLAUSE.test(clause) || starClause)) {
    return "log-via-transport";
  }
  return null;
}

function lineOf(source: string, index: number): number {
  return source.slice(0, index).split("\n").length;
}

const DECL_WORD = /\b(?:const|let|var)\b/;

/**
 * Enclosing declaration for dynamic/require edges, so `const {\n maskEnv,\n}
 * = await import(...)` flags like its single-line form: a balanced-brace walk
 * BACK to the binding (a `}` at depth zero whose remainder names const/let/var
 * is our destructuring's close; otherwise it is a prior block's, and the
 * statement starts after it; a `{` closing the walk to depth zero stops at
 * the declaration keyword immediately before it, bounding the walk inside
 * embedding code) and FORWARD to the statement's closing `;` (an unbalanced
 * closer at depth zero ends it, for ASI-style code).
 */
function enclosingStatement(source: string, matchStart: number, matchEnd: number): string {
  let depth = 0;
  let i = matchStart - 1;
  let start = 0;
  while (i >= 0) {
    const c = source[i]!;
    if (c === "}") {
      if (depth === 0 && DECL_WORD.test(source.slice(i + 1, matchStart))) {
        start = i + 1;
        break;
      }
      depth += 1;
    } else if (c === "{") {
      if (depth === 0) {
        start = i + 1;
        break;
      }
      if (depth - 1 === 0) {
        let k = i - 1;
        while (k >= 0 && /\s/.test(source[k]!)) k -= 1;
        let w = k;
        while (w >= 0 && /[A-Za-z0-9_$]/.test(source[w]!)) w -= 1;
        if (w + 1 <= k && DECL_WORD.test(source.slice(w + 1, k + 1))) {
          start = w + 1;
          break;
        }
      }
      depth -= 1;
    } else if (depth === 0 && (c === ";" || c === "," || c === "[" || c === "(" || c === "'" || c === '"' || c === "`")) {
      start = i + 1;
      break;
    }
    i -= 1;
  }
  let bracketDepth = 0;
  let end = source.length;
  for (let j = matchEnd; j < source.length; j += 1) {
    const c = source[j]!;
    if (c === "(" || c === "{" || c === "[") {
      bracketDepth += 1;
    } else if (c === ")" || c === "}" || c === "]") {
      if (bracketDepth === 0) {
        end = j;
        break;
      }
      bracketDepth -= 1;
    } else if (c === ";" && bracketDepth === 0) {
      end = j;
      break;
    }
  }
  return source.slice(start, end);
}

const CLAUSE_STATIC = (m: RegExpMatchArray): string => m.groups?.clause ?? ""; // dp:ok the clause capture is required by STATIC_EDGE — ?? only satisfies noUncheckedIndexedAccess typing; "" is unreachable for a live match
const CLAUSE_NONE = (): string => "";

function scanModule(file: string, source: string, scope: ScanScope = "production"): DormancyViolation[] {
  const violations: DormancyViolation[] = [];
  const seen = new Set<string>();
  const report = (kind: DormancyKind, specifier: string, line: number): void => {
    const key = `${kind}|${specifier}|${line}`;
    if (seen.has(key)) return;
    seen.add(key);
    violations.push({ kind, specifier, line, file });
  };
  // Raw-text pass (line-anchored static edges — survives any stripper blind
  // spot, e.g. a quote inside a regex literal) union the comment-stripped pass
  // (dynamic/require plus non-line-start statics, comments blanked). The
  // lexer is position-preserving, so both passes share indices, line numbers,
  // and the single string-span set that keeps planted `import(...)` strings
  // from reading as dynamic edges.
  const stripped = lexSource(source);
  const views: ReadonlyArray<readonly [string, ReadonlyArray<readonly [number, number]>]> = [
    [source, stripped.stringSpans],
    [stripped.text, stripped.stringSpans],
  ];
  for (const [text, stringSpans] of views) {
    const staticEdges: ReadonlyArray<readonly [RegExp, (m: RegExpMatchArray) => string]> = [
      [STATIC_EDGE, CLAUSE_STATIC],
      [SIDE_EFFECT, CLAUSE_NONE],
    ];
    for (const [regex, clauseOf] of staticEdges) {
      regex.lastIndex = 0; // /g regexes are module constants; matchAll honours lastIndex
      for (const m of text.matchAll(regex)) {
        const specifier = m.groups?.spec ?? ""; // dp:ok the spec capture is required by every edge regex — "" is unreachable for a live match and would classify as no violation, not a silent blank
        const kind = classifyEdge(file, clauseOf(m), specifier, scope);
        if (!kind) continue;
        const kwOffset = m[0].search(/import|export/);
        const kwIndex = (m.index ?? 0) + (kwOffset === -1 ? 0 : kwOffset);
        report(kind, specifier, lineOf(text, kwIndex));
      }
    }
    for (const regex of [DYNAMIC, REQUIRE]) {
      regex.lastIndex = 0;
      for (const m of text.matchAll(regex)) {
        if (inStringSpan(stringSpans, m.index ?? 0)) continue;
        const specifier = m.groups?.spec ?? ""; // dp:ok the spec capture is required by every edge regex — "" is unreachable for a live match and would classify as no violation, not a silent blank
        const kind = classifyEdge(file, enclosingStatement(text, m.index ?? 0, (m.index ?? 0) + m[0].length), specifier, scope);
        if (!kind) continue;
        report(kind, specifier, lineOf(text, m.index ?? 0));
      }
    }
  }
  return violations;
}

/** Repo-relative path (posix separators) — what failure messages name. */
function relFromRoot(file: string): string {
  return relative(ROOT, resolve(file)).split(sep).join("/");
}

/** Every JS/TS module under dir, sorted, recursively (ts-family AND the
 * js-family the tail rules already accept — breadth must match the rules). */
function listModules(dir: string): string[] {
  const files: string[] = [];
  const visit = (d: string): void => {
    const entries = readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) {
        visit(p);
      } else if (/\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(e.name)) {
        files.push(p);
      }
    }
  };
  visit(dir);
  return files;
}

function dormancyScan(files: readonly string[], scope: ScanScope): DormancyViolation[] {
  return files.flatMap((f) => scanModule(f, readFileSync(f, "utf8"), scope));
}

// ---------------------------------------------------------------------------
// Real-tree scan
// ---------------------------------------------------------------------------

const SRC_FILES = listModules(join(ROOT, "src"));
const SCRIPT_FILES = listModules(join(ROOT, "scripts"));
const VISUALIZER_FILES = listModules(join(ROOT, "visualizer"));
const TESTS_FILES = listModules(join(ROOT, "tests"));

describe("z5 AC4 dormancy guard — production trees", () => {
  test("the walk covers src/, scripts/, visualizer/, tests/ (non-vacuous: sentinels present)", () => {
    expect(SRC_FILES.length).toBeGreaterThan(0);
    expect(SCRIPT_FILES.length).toBeGreaterThan(0);
    expect(VISUALIZER_FILES.length).toBeGreaterThan(0);
    expect(TESTS_FILES.length).toBeGreaterThan(0);
    expect(SRC_FILES.map(relFromRoot)).toContain("src/swarmclaw/mcp/tool-bridge.ts");
    expect(SRC_FILES.map(relFromRoot)).toContain("src/swarmclaw/routes/agents.ts");
    expect(SRC_FILES.map(relFromRoot)).toContain("src/swarmclaw/store/mcp-store.ts");
    expect(SRC_FILES.map(relFromRoot)).toContain("src/index.ts");
    expect(SRC_FILES.map(relFromRoot)).toContain("src/lib/log.ts");
    expect(SRC_FILES.map(relFromRoot)).toContain("src/lib/mask-env.ts");
    expect(SCRIPT_FILES.map(relFromRoot)).toContain("scripts/fleet.ts");
    expect(VISUALIZER_FILES.map(relFromRoot)).toContain("visualizer/deploy.ts");
    expect(TESTS_FILES.map(relFromRoot)).toContain("tests/swarmclaw/index.test.ts");
  });

  test("the origin stays gone and the homes exist (I1/I2 continuity)", () => {
    expect(existsSync(RESOLVED_LOG)).toBe(false);
    expect(existsSync(join(ROOT, "src", "lib", "log.ts"))).toBe(true);
    expect(existsSync(join(ROOT, "src", "lib", "mask-env.ts"))).toBe(true);
  });

  test("all walked trees are quiet — production under all four rules, tests/ under rules 1/2/4", () => {
    // A regression prints the guard's formatted messages, each naming its
    // offending path — AC4's failure contract, asserted directly.
    const production = dormancyScan([...SRC_FILES, ...SCRIPT_FILES, ...VISUALIZER_FILES], "production");
    expect(production.map(formatViolation)).toEqual([]);
    expect(dormancyScan(TESTS_FILES, "tests").map(formatViolation)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Negative controls — planted violations must FAIL naming the offending path
// ---------------------------------------------------------------------------

const PLANTED_LOG_IMPORT = 'import { log } from "./swarmclaw/log.ts";\n';
const PLANTED_BRIDGE_IMPORT = 'import { maskEnv } from "./swarmclaw/mcp/tool-bridge.ts";\n';
const PLANTED_TRANSPORT_IMPORT = 'import { setLogSink } from "./swarmclaw/mcp/stdio-transport.ts";\n';

describe("z5 AC4 dormancy guard — negative controls", () => {
  test("planted swarmclaw/log import in a synthetic temp tree fails, naming the path", () => {
    const dir = mkdtempSync(join(tmpdir(), "qds-dormancy-log-"));
    try {
      const planted = join(dir, "planted.ts");
      const innocent = join(dir, "innocent.ts");
      writeFileSync(planted, PLANTED_LOG_IMPORT);
      // The sanctioned edge, same tree: proves the scan is selective, not
      // "flags everything in the plant dir".
      writeFileSync(innocent, 'import { log } from "../lib/log.ts";\n');
      const violations = dormancyScan(listModules(dir), "production");
      expect(violations.length).toBe(1);
      expect(violations[0]?.kind).toBe("log-origin-import");
      expect(violations[0]?.file).toBe(planted);
      expect(violations[0]?.line).toBe(1);
      // AC4's failure contract, asserted on the guard's FORMATTED message:
      // it names the offending path (and the rule that fired).
      const message = formatViolation(violations[0]!);
      expect(message).toContain(planted);
      expect(message).toContain("log-origin-import");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("planted maskEnv-from-tool-bridge edge fails, naming the path; bridge use without maskEnv stays clean", () => {
    const dir = mkdtempSync(join(tmpdir(), "qds-dormancy-bridge-"));
    try {
      const planted = join(dir, "bridge-coupling.ts");
      const legit = join(dir, "legit-bridge-use.ts");
      writeFileSync(planted, PLANTED_BRIDGE_IMPORT);
      // Importing the bridge itself is fine — only the maskEnv coupling is dead.
      writeFileSync(legit, 'import { ToolBridge } from "./swarmclaw/mcp/tool-bridge.ts";\n');
      const violations = dormancyScan(listModules(dir), "production");
      expect(violations.length).toBe(1);
      expect(violations[0]?.kind).toBe("maskenv-from-tool-bridge");
      expect(violations[0]?.file).toBe(planted);
      expect(violations[0]?.specifier).toBe("./swarmclaw/mcp/tool-bridge.ts");
      expect(formatViolation(violations[0]!)).toContain(planted);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("in-memory plants hit the same scanner code path and name their synthetic label", () => {
    const logPlant = scanModule("synthetic/log-consumer.ts", PLANTED_LOG_IMPORT);
    expect(logPlant.length).toBe(1);
    expect(logPlant[0]?.file).toBe("synthetic/log-consumer.ts");
    expect(logPlant[0]?.kind).toBe("log-origin-import");
    const bridgePlant = scanModule("synthetic/bridge-consumer.ts", PLANTED_BRIDGE_IMPORT);
    expect(bridgePlant.length).toBe(1);
    expect(bridgePlant[0]?.kind).toBe("maskenv-from-tool-bridge");
  });

  test("planted server-surface imports fail naming the paths; subtree-internal use stays clean (clause a)", () => {
    const dir = mkdtempSync(join(tmpdir(), "qds-dormancy-surface-"));
    try {
      const plants = new Map<string, string>([
        [join(dir, "barrel-coupling.ts"), 'import { createServer } from "./swarmclaw/index.ts";\n'],
        [join(dir, "routes-coupling.ts"), 'import { logResponse } from "./swarmclaw/routes/agents.ts";\n'],
        [join(dir, "store-coupling.ts"), 'import { MCPStore } from "./swarmclaw/store/mcp-store.ts";\n'],
      ]);
      for (const [path, source] of plants) writeFileSync(path, source);
      const violations = dormancyScan(listModules(dir), "production");
      expect(violations.length).toBe(3);
      for (const v of violations) expect(v.kind).toBe("server-surface-import");
      // Every offending path is named in the guard's formatted messages.
      const formatted = violations.map(formatViolation).join("\n");
      for (const path of plants.keys()) expect(formatted).toContain(path);
      // Clause (a) binds OUTSIDERS only: the same wiring inside the subtree
      // is the surface's own business (in-memory label, nothing on disk).
      const internal = join(ROOT, "src", "swarmclaw", "routes", "dormancy-synthetic-internal.ts");
      expect(scanModule(internal, 'import { MCPStore } from "../store/mcp-store.ts";\n')).toEqual([]);
      expect(scanModule(internal, 'import { createServer } from "../index.ts";\n')).toEqual([]);
      // The sanctioned lib homes stay unflagged for clause (a) too.
      expect(scanModule("synthetic/clean.ts", 'import { log } from "../lib/log.ts";\n')).toEqual([]);
      expect(scanModule("synthetic/clean.ts", 'import { maskEnv } from "../lib/mask-env.ts";\n')).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("planted log-via-transport re-export fails, naming the path; StdioTransport-only clause stays clean", () => {
    const dir = mkdtempSync(join(tmpdir(), "qds-dormancy-transport-"));
    try {
      const planted = join(dir, "transport-coupling.ts");
      const legit = join(dir, "legit-transport-use.ts");
      writeFileSync(planted, PLANTED_TRANSPORT_IMPORT);
      // The transport's own API is fine — only the log trio riding on it died.
      writeFileSync(legit, 'import { StdioTransport } from "./swarmclaw/mcp/stdio-transport.ts";\n');
      const violations = dormancyScan(listModules(dir), "production");
      expect(violations.length).toBe(1);
      expect(violations[0]?.kind).toBe("log-via-transport");
      expect(violations[0]?.file).toBe(planted);
      expect(violations[0]?.specifier).toBe("./swarmclaw/mcp/stdio-transport.ts");
      expect(formatViolation(violations[0]!)).toContain(planted);
      // Clean shape mirroring the real consumers (tool-bridge, mcp-servers,
      // mcp-store import StdioTransport et al. WITHOUT any log symbol): the
      // multiline clause carries no restored-re-export symbol.
      expect(
        scanModule(
          "synthetic/transport-clean.ts",
          'import {\n  buildSubprocessEnv,\n  StdioTransport,\n  validateCommand,\n} from "../mcp/stdio-transport.ts";\n',
        ),
      ).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Positive control + parser controls
// ---------------------------------------------------------------------------

describe("z5 AC4 dormancy guard — barrel exemption and parser", () => {
  test("positive control: the barrel is exempt for rule 3 ONLY — rules 1, 2, 4 still bind it", () => {
    expect(EXEMPT_BARREL).toBe("src/index.ts");
    // The real barrel, real content, real path — clean.
    const barrelPath = join(ROOT, "src", "index.ts");
    expect(scanModule(barrelPath, readFileSync(barrelPath, "utf8"))).toEqual([]);
    // Exercised for real, rule 3: the barrel's mandated createServer
    // re-export under the barrel's exact path is exempt — load-bearing.
    const surfacePlant = 'import { createServer } from "../swarmclaw/index.ts";\n';
    expect(scanModule(barrelPath, surfacePlant)).toEqual([]);
    // BOTH directions of the narrowed exemption: the same barrel path still
    // flags for the utility dormancy rules — log-origin…
    const barrelLog = scanModule(barrelPath, PLANTED_LOG_IMPORT);
    expect(barrelLog.length).toBe(1);
    expect(barrelLog[0]?.kind).toBe("log-origin-import");
    // …maskEnv severance…
    const barrelBridge = scanModule(barrelPath, PLANTED_BRIDGE_IMPORT);
    expect(barrelBridge.length).toBe(1);
    expect(barrelBridge[0]?.kind).toBe("maskenv-from-tool-bridge");
    // …and log-via-transport.
    const barrelTransport = scanModule(barrelPath, PLANTED_TRANSPORT_IMPORT);
    expect(barrelTransport.length).toBe(1);
    expect(barrelTransport[0]?.kind).toBe("log-via-transport");
    // Narrowness, rule 3: the same plant one directory over — outside the
    // retained subtree, unexempt — is flagged; a prefix-wide exemption (src/)
    // fails this half. The label sits OUTSIDE src/swarmclaw/ because rule 3
    // binds outsiders only.
    const nearBarrel = join(ROOT, "src", "dormancy-synthetic-non-barrel.ts");
    const flagged = scanModule(nearBarrel, PLANTED_LOG_IMPORT);
    expect(flagged.length).toBe(1);
    expect(flagged[0]?.file).toBe(nearBarrel);
    const flaggedSurface = scanModule(nearBarrel, surfacePlant);
    expect(flaggedSurface.length).toBe(1);
    expect(flaggedSurface[0]?.kind).toBe("server-surface-import");
    // Symmetric clean pin: the identical plant under a src/swarmclaw/-internal
    // non-barrel path is NOT flagged — the surface's own wiring is its own.
    const insideSurface = scanModule(
      join(ROOT, "src", "swarmclaw", "dormancy-synthetic-non-barrel.ts"),
      surfacePlant,
    );
    expect(insideSurface).toEqual([]);
  });

  test("parser pins: every import form that references the dead origin is caught", () => {
    const forms: ReadonlyArray<readonly [string, string]> = [
      ["named import", 'import { log } from "../swarmclaw/log.ts";\n'],
      ["multiline import", 'import {\n  logMuted,\n  setLogSink,\n} from "../swarmclaw/log.ts";\n'],
      ["side-effect import", 'import "../swarmclaw/log.ts";\n'],
      ["named re-export", 'export { log } from "../swarmclaw/log.ts";\n'],
      ["star re-export", 'export * from "../swarmclaw/log.ts";\n'],
      ["namespace import", 'import * as logs from "../swarmclaw/log.ts";\n'],
      ["type-only import", 'import type { LogEntry } from "../swarmclaw/log.ts";\n'],
      ["dynamic import", 'const m = await import("../swarmclaw/log.ts");\n'],
      ["require", 'const m = require("../swarmclaw/log.ts");\n'],
      ["extensionless", 'import { log } from "../swarmclaw/log";\n'],
      ["d.ts declaration resurrection", 'import type { LogEntry } from "../swarmclaw/log.d.ts";\n'],
    ];
    // Case names ride inside the toEqual diff, so a regression names its form.
    const observed = forms.map(([name, source]) => {
      const v = scanModule("synthetic/form-consumer.ts", source);
      return { form: name, count: v.length, kind: v[0]?.kind ?? null };
    });
    expect(observed).toEqual(
      forms.map(([name]) => ({ form: name, count: 1, kind: "log-origin-import" as const })),
    );
    // The reported line is the KEYWORD's line, not the specifier's: with three
    // filler lines above it, the multiline import's `import` sits on line 4.
    const multiline = scanModule(
      "synthetic/multiline.ts",
      'const x = 1;\nconst y = 2;\nconst z = 3;\nimport {\n  logMuted,\n  setLogSink,\n} from "../swarmclaw/log.ts";\n',
    );
    expect(multiline.length).toBe(1);
    expect(multiline[0]?.line).toBe(4);
    // Index-barrel resurrection: an import resolving under src/swarmclaw/log/
    // is the origin reborn as a directory. The tail cannot see it (the
    // specifier ends in /index.ts), so only the resolved rule catches it —
    // which needs a label inside the repo (this label names no file on disk).
    const dirResurrection = scanModule(
      join(ROOT, "src", "lib", "dormancy-synthetic-label.ts"),
      'import { log } from "../swarmclaw/log/index.ts";\n',
    );
    expect(dirResurrection.length).toBe(1);
    expect(dirResurrection[0]?.kind).toBe("log-origin-import");
  });

  test("parser pins: only the maskEnv clause is dead on tool-bridge — named, star, and namespace forms", () => {
    const flagged: ReadonlyArray<readonly [string, string]> = [
      ["named clause", 'import { maskEnv } from "../../swarmclaw/mcp/tool-bridge.ts";\n'],
      ["aliased clause", 'import { maskEnv as m } from "../../swarmclaw/mcp/tool-bridge.ts";\n'],
      ["re-export clause", 'export { maskEnv } from "../swarmclaw/mcp/tool-bridge.ts";\n'],
      ["dynamic destructure, single-line", 'const { maskEnv } = await import("../swarmclaw/mcp/tool-bridge.ts");\n'],
      [
        "dynamic destructure, multiline",
        'const {\n  maskEnv,\n} = await import("../swarmclaw/mcp/tool-bridge.ts");\n',
      ],
      [
        "dynamic destructure, binding separated from the call",
        'const {\n  maskEnv,\n} =\n  await import("../swarmclaw/mcp/tool-bridge.ts");\n',
      ],
      ["namespace import reaches the fenced symbol", 'import * as tb from "../../swarmclaw/mcp/tool-bridge.ts";\n'],
      ["export-star reaches the fenced surface", 'export * from "../swarmclaw/mcp/tool-bridge.ts";\n'],
    ];
    const observed = flagged.map(([name, source]) => {
      const v = scanModule("synthetic/bridge-form-consumer.ts", source);
      return { form: name, count: v.length, kind: v[0]?.kind ?? null };
    });
    expect(observed).toEqual(
      flagged.map(([name]) => ({ form: name, count: 1, kind: "maskenv-from-tool-bridge" as const })),
    );
    // The dot-dot specifier has no contiguous swarmclaw/mcp tail, so only the
    // resolved rule can catch it — which needs a label inside the repo to
    // resolve against (this label names no file on disk; nothing is written).
    const resolved = scanModule(
      join(ROOT, "src", "providers", "dormancy-synthetic-label.ts"),
      'import { maskEnv } from "../swarmclaw/mcp/../mcp/tool-bridge.ts";\n',
    );
    expect(resolved.length).toBe(1);
    expect(resolved[0]?.kind).toBe("maskenv-from-tool-bridge");
    // Clean edges: the bridge itself without maskEnv (named import — a
    // namespace binding is NOT clean, pinned above), and the sanctioned homes.
    expect(scanModule("synthetic/clean.ts", 'import { ToolBridge } from "../mcp/tool-bridge.ts";\n')).toEqual([]);
    expect(scanModule("synthetic/clean.ts", 'import { maskEnv } from "../lib/mask-env.ts";\n')).toEqual([]);
    expect(scanModule("synthetic/clean.ts", 'import { log } from "../lib/log.ts";\n')).toEqual([]);
  });

  test("parser pins: rule 4 log-via-transport — clause symbols, star/namespace, resolved arm", () => {
    const flagged: ReadonlyArray<readonly [string, string]> = [
      ["named log", 'import { log } from "../swarmclaw/mcp/stdio-transport.ts";\n'],
      ["logMuted is enforced-absent", 'import { logMuted } from "../swarmclaw/mcp/stdio-transport.ts";\n'],
      ["aliased setLogSink", 'import { setLogSink as s } from "../../swarmclaw/mcp/stdio-transport.ts";\n'],
      ["type-only LogEntry", 'import type { LogEntry } from "../swarmclaw/mcp/stdio-transport.ts";\n'],
      ["re-export newRequestId", 'export { newRequestId } from "../swarmclaw/mcp/stdio-transport.ts";\n'],
      ["namespace import", 'import * as t from "../swarmclaw/mcp/stdio-transport.ts";\n'],
      ["export-star", 'export * from "../swarmclaw/mcp/stdio-transport.ts";\n'],
      [
        "multiline dynamic destructure",
        'const {\n  setLogSink,\n} = await import("../swarmclaw/mcp/stdio-transport.ts");\n',
      ],
      ["template-literal specifier, plain", 'const { log } = await import(`../swarmclaw/mcp/stdio-transport.ts`);\n'],
    ];
    const observed = flagged.map(([name, source]) => {
      const v = scanModule("synthetic/transport-form-consumer.ts", source);
      return { form: name, count: v.length, kind: v[0]?.kind ?? null };
    });
    expect(observed).toEqual(
      flagged.map(([name]) => ({ form: name, count: 1, kind: "log-via-transport" as const })),
    );
    // Resolved arm: the contorted specifier has no contiguous swarmclaw/mcp
    // tail, so only resolution catches it — needing a label inside the repo
    // (this label names no file on disk; nothing is written).
    const resolved = scanModule(
      join(ROOT, "src", "lib", "dormancy-synthetic-label.ts"),
      'import { setLogSink } from "../swarmclaw/mcp/../mcp/stdio-transport.ts";\n',
    );
    expect(resolved.length).toBe(1);
    expect(resolved[0]?.kind).toBe("log-via-transport");
    // Clean: the transport's own API without any log symbol — the real shape
    // the production consumers use today (tool-bridge, mcp-servers, mcp-store).
    const clean: ReadonlyArray<readonly [string, string]> = [
      ["StdioTransport only", 'import { StdioTransport } from "../swarmclaw/mcp/stdio-transport.ts";\n'],
      [
        "real-shape multiline clause",
        'import {\n  buildSubprocessEnv,\n  JsonRpcError,\n  StdioTransport,\n  validateCommand,\n} from "../mcp/stdio-transport.ts";\n',
      ],
      ["transport of an unrelated name", 'import { x } from "../swarmclaw/mcp/stdio-transport-ish.ts";\n'],
    ];
    const cleanObserved = clean.map(([name, source]) => {
      const v = scanModule("synthetic/transport-clean.ts", source);
      return { form: name, count: v.length };
    });
    expect(cleanObserved).toEqual(clean.map(([name]) => ({ form: name, count: 0 })));
  });

  test("parser pins: rule 3 server-surface shapes — outsiders only, tests/ carve-out, named edges", () => {
    const flagged: ReadonlyArray<readonly [string, string]> = [
      ["createServer named", 'import { createServer } from "../swarmclaw/index.ts";\n'],
      ["createServer aliased", 'import { createServer as srv } from "../swarmclaw/index.ts";\n'],
      ["createServer re-export", 'export { createServer } from "../swarmclaw/index.ts";\n'],
      ["createServer clause, non-routes target", 'import { createServer } from "../swarmclaw/mcp/tool-bridge.ts";\n'],
      ["routes module", 'import { logResponse } from "../swarmclaw/routes/agents.ts";\n'],
      ["store module", 'import { MCPStore } from "../swarmclaw/store/mcp-store.ts";\n'],
      [
        "createServer dynamic destructure, multiline",
        'const {\n  createServer,\n} = await import("../swarmclaw/index.ts");\n',
      ],
    ];
    const observed = flagged.map(([name, source]) => {
      const v = scanModule("synthetic/surface-consumer.ts", source);
      return { form: name, count: v.length, kind: v[0]?.kind ?? null };
    });
    expect(observed).toEqual(
      flagged.map(([name]) => ({ form: name, count: 1, kind: "server-surface-import" as const })),
    );
    // The dot-dot specifier has no contiguous /swarmclaw/routes/ tail, so only
    // the resolved rule can catch it — which needs a label inside the repo to
    // resolve against (this label names no file on disk; nothing is written).
    const resolved = scanModule(
      join(ROOT, "src", "lib", "dormancy-synthetic-label.ts"),
      'import { logResponse } from "../swarmclaw/mcp/../routes/agents.ts";\n',
    );
    expect(resolved.length).toBe(1);
    expect(resolved[0]?.kind).toBe("server-surface-import");
    // Scope carve-out (round-2): rule 3 is production-only. The import that
    // fixture tests make BY DESIGN (tests/swarmclaw/index.test.ts:9) is clean
    // under the tests/ scope and flagged under the production scope — both
    // directions pinned.
    const byDesign = 'import { createServer } from "../../src/swarmclaw/index.ts";\n';
    expect(scanModule("tests/swarmclaw/index.test.ts", byDesign, "tests")).toEqual([]);
    const productionScoped = scanModule("tests/swarmclaw/index.test.ts", byDesign, "production");
    expect(productionScoped.length).toBe(1);
    expect(productionScoped[0]?.kind).toBe("server-surface-import");
    // Clean shapes: rule 3 keys on the SPECIFIER, so a createServer import
    // from outside the subtree is fine (node:http); a namespace import names no
    // createServer binding; the maskEnv rule governs tool-bridge imports.
    const clean: ReadonlyArray<readonly [string, string]> = [
      ["node:http createServer", 'import { createServer } from "node:http";\n'],
      ["namespace barrel import", 'import * as server from "../swarmclaw/index.ts";\n'],
      ["bridge without createServer", 'import { ToolBridge } from "../swarmclaw/mcp/tool-bridge.ts";\n'],
    ];
    const cleanObserved = clean.map(([name, source]) => {
      const v = scanModule("synthetic/surface-clean.ts", source);
      return { form: name, count: v.length };
    });
    expect(cleanObserved).toEqual(clean.map(([name]) => ({ form: name, count: 0 })));
  });

  test("template-literal ceiling: plain specifiers are scanned, interpolated ones are not", () => {
    // Plain template (no ${}) — the static text IS the specifier: caught.
    const plain = scanModule("synthetic/template-plain.ts", 'const { log } = await import(`../swarmclaw/log.ts`);\n');
    expect(plain.length).toBe(1);
    expect(plain[0]?.kind).toBe("log-origin-import");
    // Interpolated — a computed specifier cannot be resolved statically; the
    // lexer ceiling documented in the header.
    const interpolated = scanModule("synthetic/template-interp.ts", 'const m = await import(`../swarmclaw/${f}.ts`);\n');
    expect(interpolated).toEqual([]);
  });

  test("text is not edges: comments, prose, strings — with the pinned raw-pass exceptions", () => {
    const clean: ReadonlyArray<readonly [string, string]> = [
      // House comment forms: // and JSDoc ` * ` never start an import edge.
      ["line comment", '// import { log } from "../swarmclaw/log.ts";\n'],
      ["jsdoc line", '/**\n * import { log } from "../swarmclaw/log.ts";\n */\n'],
      // THE documented deviation vs AC3's raw grep: a trailing comment may
      // mention the dead path — prose, not an import edge (AC3 grep still
      // polices comment text; this parser must not double-report it).
      ["trailing comment mentions the path", 'import { log } from "../lib/log.ts"; // history: ../swarmclaw/log.ts\n'],
      ["prose names the package only", '// the swarmclaw server handles requests\n'],
      ["url string", 'const u = "https://example.com//swarmclaw/log";\n'],
      // Round-2 string-awareness: a dynamic import inside a string interior is
      // planted text, not an edge (this is what keeps code-fragment-bearing
      // test files clean under the tests/ walk).
      [
        "dynamic import inside a string literal",
        'const CODE = "await import(\'../swarmclaw/log.ts\')";\n',
      ],
    ];
    const observed = clean.map(([name, source]) => {
      const v = scanModule("synthetic/text-consumer.ts", source);
      return { form: name, count: v.length };
    });
    expect(observed).toEqual(clean.map(([name]) => ({ form: name, count: 0 })));
    // Regex-literal decoy (a quote inside a regex) must not blind the raw pass:
    // the real import after it is still caught.
    const decoy = scanModule(
      "synthetic/regex-decoy.ts",
      'const R = /["\']/;\nimport { log } from "../swarmclaw/log.ts";\n',
    );
    expect(decoy.length).toBe(1);
    // Honest counter-cases, pinned on purpose: text at TRUE line start inside
    // a block comment or template literal is code-shaped to the line-anchored
    // raw pass, so it IS flagged — coherent, not a regression: the raw text
    // contains the dead path, which is already an AC3 zero-mentions violation.
    const blockComment = scanModule(
      "synthetic/block-comment.ts",
      '/**\nimport { log } from "../swarmclaw/log.ts";\n */\n',
    );
    expect(blockComment.length).toBe(1);
    const templateText = scanModule(
      "synthetic/template-text.ts",
      "const DOC = `\nimport { log } from '../swarmclaw/log.ts';\n`;\n",
    );
    expect(templateText.length).toBe(1);
  });
});
