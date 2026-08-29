/**
 * DF4.2 AC2: the declared Bun-only runtime surface stays exact for the forms
 * this scanner recognizes, over server/**, src/**, and scripts/**.
 *
 * Scans with the TypeScript compiler API — not regex — so a JSDoc comment
 * mentioning `Bun.serve` or a `ReturnType<typeof Bun.serve>` type position
 * can never masquerade as a runtime usage (see server/bun-apis.ts for why a
 * naive text scan gets both of those wrong). Fails in both directions: a
 * real usage missing from the inventory, or an inventory entry with no
 * corresponding real usage. `import.meta.<x>` is checked against an
 * explicit Bun-only allow-list (BUN_ONLY_IMPORT_META_PROPS) so the standard
 * `import.meta.url` is never flagged.
 *
 * Recognized usage forms: `Bun.<x>` and `Bun["<x>"]` property/element
 * access, `import.meta.<bun-only-prop>`, static and dynamic `bun:` imports
 * (`import`, `import()`, `export ... from`), and `require("bun:...")`.
 *
 * Known, deliberate gaps (not attempted — would need dataflow analysis, and
 * neither form exists anywhere in this tree today): destructuring off the
 * `Bun` global (`const { serve } = Bun`) and aliasing it to another binding
 * (`const B = Bun; B.serve()`). If either appears in real code, extend the
 * scanner then rather than guessing at forms nothing uses yet.
 */
import { describe, expect, test } from "bun:test";
import * as ts from "typescript";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { BUN_APIS } from "../server/bun-apis.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const SCAN_ROOTS = [
  join(import.meta.dir, "..", "server"),
  join(import.meta.dir, "..", "src"),
  join(import.meta.dir, "..", "scripts"),
];

/**
 * `import.meta` properties that are actually Bun-only. `import.meta.url` is
 * standard ES (works in Node too) and must NOT be flagged — see the fixture
 * test proving that below. Bun's own docs are the source of this list; add
 * to it only for a property Bun documents as its own extension.
 */
const BUN_ONLY_IMPORT_META_PROPS = new Set(["dir", "main", "file", "path"]);

/** One real, runtime Bun-API touchpoint found in the source tree. */
interface Usage {
  /** Inventory key it corresponds to, e.g. "Bun.serve" or "bun:sqlite". */
  api: string;
  /** Repo-relative "path:line". */
  location: string;
}

/** True if `node` sits under a TypeNode ancestor — a `typeof X` type query, etc. */
function inTypePosition(node: ts.Node): boolean {
  let cur: ts.Node | undefined = node;
  while (cur) {
    if (ts.isTypeNode(cur)) return true;
    if (ts.isImportTypeNode(cur)) return true;
    cur = cur.parent;
  }
  return false;
}

/**
 * Walks a TypeScript AST and returns every runtime (non-type, non-comment)
 * touchpoint of a Bun-only API: `Bun.<x>` / `import.meta.<x>` property
 * access in a value position, or an import specifier starting `bun:`.
 * Comments never produce nodes, so they are structurally excluded; type
 * positions are excluded by walking up to the nearest TypeNode ancestor.
 */
function findBunUsages(sourceText: string, fileName: string): Usage[] {
  const sourceFile = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
  const usages: Usage[] = [];

  function lineOf(node: ts.Node): number {
    return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  }

  function visit(node: ts.Node): void {
    if (ts.isPropertyAccessExpression(node) && !inTypePosition(node)) {
      const obj = node.expression;
      if (ts.isIdentifier(obj) && obj.text === "Bun") {
        usages.push({ api: `Bun.${node.name.text}`, location: `${fileName}:${lineOf(node)}` });
      } else if (
        ts.isMetaProperty(obj) &&
        obj.keywordToken === ts.SyntaxKind.ImportKeyword &&
        BUN_ONLY_IMPORT_META_PROPS.has(node.name.text)
      ) {
        // `import.meta.dir` parses as PropertyAccessExpression(MetaProperty, "dir").
        // `import.meta.url` is standard ES (works in Node too) and is excluded
        // by the allow-list check above — see BUN_ONLY_IMPORT_META_PROPS.
        usages.push({ api: `import.meta.${node.name.text}`, location: `${fileName}:${lineOf(node)}` });
      }
    }
    // `Bun["serve"]` — same idea as Bun.serve, via bracket access with a string literal.
    if (
      ts.isElementAccessExpression(node) &&
      !inTypePosition(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "Bun" &&
      node.argumentExpression &&
      ts.isStringLiteral(node.argumentExpression)
    ) {
      usages.push({ api: `Bun.${node.argumentExpression.text}`, location: `${fileName}:${lineOf(node)}` });
    }
    // `require("bun:sqlite")` — CommonJS-style require of a bun: module.
    if (
      ts.isCallExpression(node) &&
      !inTypePosition(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "require" &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0]) &&
      node.arguments[0].text.startsWith("bun:")
    ) {
      usages.push({ api: node.arguments[0].text, location: `${fileName}:${lineOf(node)}` });
    }
    if (!inTypePosition(node)) {
      let spec: ts.Expression | undefined;
      let isTypeOnly = false;
      if (ts.isImportDeclaration(node)) {
        spec = node.moduleSpecifier;
        // Declaration-level `import type ... from "bun:x"` is erased whole.
        // A side-effect import (`import "bun:x"`, no importClause) and a
        // default/namespace import always carry runtime weight. Only a
        // NamedImports clause needs the finer check: `import { type Foo }`
        // is erased per-specifier, so the declaration is type-only overall
        // only when EVERY named specifier is `type`.
        const clause = node.importClause;
        if (clause?.isTypeOnly) {
          isTypeOnly = true;
        } else if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
          const named = clause.namedBindings.elements;
          const hasRuntimeSpecifier = named.some((el) => !el.isTypeOnly);
          // A named clause with elements but none carrying runtime weight,
          // and no default/namespace binding alongside it, is fully erased.
          isTypeOnly = named.length > 0 && !hasRuntimeSpecifier && !clause.name;
        }
      } else if (ts.isExportDeclaration(node)) {
        spec = node.moduleSpecifier;
        // Same per-specifier logic for `export { type Foo } from "bun:x"`.
        // `export * from "bun:x"` (no exportClause) always carries runtime
        // weight — there is no per-symbol erasure to check.
        if (node.isTypeOnly) {
          isTypeOnly = true;
        } else if (node.exportClause && ts.isNamedExports(node.exportClause)) {
          const named = node.exportClause.elements;
          isTypeOnly = named.length > 0 && named.every((el) => el.isTypeOnly);
        }
      } else if (ts.isExternalModuleReference(node)) {
        spec = node.expression;
      }
      if (!isTypeOnly && spec && ts.isStringLiteral(spec) && spec.text.startsWith("bun:")) {
        usages.push({ api: spec.text, location: `${fileName}:${lineOf(node)}` });
      }
    }
    // Dynamic `import("bun:sqlite")`: a CallExpression on the `import` keyword.
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      !inTypePosition(node)
    ) {
      const arg = node.arguments[0];
      if (arg && ts.isStringLiteral(arg) && arg.text.startsWith("bun:")) {
        usages.push({ api: arg.text, location: `${fileName}:${lineOf(node)}` });
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return usages;
}

/** Recursively lists .ts/.tsx files under `dir`, skipping `test/` entirely. */
function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...listSourceFiles(full));
    } else if (/\.tsx?$/.test(entry) && entry !== "bun-apis.ts") {
      out.push(full);
    }
  }
  return out;
}

function scanRepo(): Usage[] {
  const usages: Usage[] = [];
  for (const root of SCAN_ROOTS) {
    for (const file of listSourceFiles(root)) {
      const text = readFileSync(file, "utf8");
      const rel = relative(REPO_ROOT, file);
      for (const usage of findBunUsages(text, file)) {
        usages.push({ api: usage.api, location: `${rel}:${usage.location.split(":").pop()}` });
      }
    }
  }
  return usages;
}

describe("Bun API inventory (DF4.2 AC2)", () => {
  const found = scanRepo();
  const foundApis = new Set(found.map((u) => u.api));
  const inventoryApis = new Set(BUN_APIS.map((e) => e.api));

  test("every real usage found in the tree is declared in the inventory", () => {
    const undeclared = [...foundApis].filter((api) => !inventoryApis.has(api));
    expect(undeclared).toEqual([]);
  });

  test("every inventory entry has at least one real usage", () => {
    const stale = [...inventoryApis].filter((api) => !foundApis.has(api));
    expect(stale).toEqual([]);
  });

  test("every inventory entry's locations match the files the scan really found", () => {
    // Files, not "path:line". A line pin breaks on any edit above the call —
    // brittle for CI and, worse, silently wrong when nothing asserts it. The
    // file set is stable under edits and still catches a moved or deleted
    // usage, which is the fact the inventory exists to record.
    const scanned = new Map<string, Set<string>>();
    for (const u of found) {
      const file = u.location.slice(0, u.location.lastIndexOf(":"));
      (scanned.get(u.api) ?? scanned.set(u.api, new Set()).get(u.api)!).add(file);
    }
    for (const entry of BUN_APIS) {
      expect({ api: entry.api, locations: entry.locations }).toEqual({
        api: entry.api,
        locations: [...(scanned.get(entry.api) ?? [])].toSorted(),
      });
    }
  });

  test("comment trap: a fixture comment mentioning Bun.serve yields zero usages", () => {
    const fixture = `
      /**
       * BEFORE Bun.serve (INV-5).
       */
      export function noop() {}
    `;
    expect(findBunUsages(fixture, "fixture.ts")).toEqual([]);
  });

  test("comment trap: auth.ts contributes no Bun usage despite the literal text Bun.serve", () => {
    const authPath = join(import.meta.dir, "..", "server", "auth.ts");
    const text = readFileSync(authPath, "utf8");
    expect(text).toContain("Bun.serve");
    const usages = findBunUsages(text, authPath);
    expect(usages).toEqual([]);
  });

  test("type-position trap: `ReturnType<typeof Bun.serve>` yields zero usages", () => {
    const fixture = "let s: ReturnType<typeof Bun.serve>;";
    expect(findBunUsages(fixture, "fixture.ts")).toEqual([]);
  });

  test("type-position trap: nested Parameters<...typeof Bun.serve...> yields zero usages", () => {
    const fixture = `
      declare const x: Parameters<NonNullable<Parameters<typeof Bun.serve>[0]["fetch"]>>[1];
    `;
    expect(findBunUsages(fixture, "fixture.ts")).toEqual([]);
  });

  test("import.meta.url is standard ES, not Bun-only, and yields zero usages", () => {
    const fixture = "console.log(import.meta.url);";
    expect(findBunUsages(fixture, "fixture.ts")).toEqual([]);
  });

  test("import.meta.dir is still detected (allow-list does not overreach)", () => {
    const fixture = "console.log(import.meta.dir);";
    expect(findBunUsages(fixture, "fixture.ts").map((u) => u.api)).toEqual(["import.meta.dir"]);
  });

  test('Bun["serve"] bracket access is detected', () => {
    const fixture = 'Bun["serve"]({ fetch: () => new Response("ok") });';
    expect(findBunUsages(fixture, "fixture.ts").map((u) => u.api)).toEqual(["Bun.serve"]);
  });

  test('require("bun:sqlite") is detected', () => {
    const fixture = 'const { Database } = require("bun:sqlite");';
    expect(findBunUsages(fixture, "fixture.ts").map((u) => u.api)).toEqual(["bun:sqlite"]);
  });

  test("export-from trap: `export { Database } from \"bun:sqlite\"` is detected", () => {
    const fixture = `export { Database } from "bun:sqlite";`;
    expect(findBunUsages(fixture, "fixture.ts").map((u) => u.api)).toEqual(["bun:sqlite"]);
  });

  test("export-from trap: type-only `export type { Database } from \"bun:sqlite\"` yields zero usages", () => {
    const fixture = `export type { Database } from "bun:sqlite";`;
    expect(findBunUsages(fixture, "fixture.ts")).toEqual([]);
  });

  test("import-specifier trap: `import { type Database } from \"bun:sqlite\"` yields zero usages", () => {
    const fixture = `import { type Database } from "bun:sqlite";`;
    expect(findBunUsages(fixture, "fixture.ts")).toEqual([]);
  });

  test("import-specifier trap: a mixed clause with one runtime specifier is still detected", () => {
    const fixture = `import { type Database, Statement } from "bun:sqlite";`;
    expect(findBunUsages(fixture, "fixture.ts").map((u) => u.api)).toEqual(["bun:sqlite"]);
  });

  test("export-specifier trap: `export { type Database } from \"bun:sqlite\"` yields zero usages", () => {
    const fixture = `export { type Database } from "bun:sqlite";`;
    expect(findBunUsages(fixture, "fixture.ts")).toEqual([]);
  });

  test("export-specifier trap: a mixed clause with one runtime specifier is still detected", () => {
    const fixture = `export { type Database, Statement } from "bun:sqlite";`;
    expect(findBunUsages(fixture, "fixture.ts").map((u) => u.api)).toEqual(["bun:sqlite"]);
  });

  test("export * from \"bun:sqlite\" is always runtime (no per-symbol erasure)", () => {
    const fixture = `export * from "bun:sqlite";`;
    expect(findBunUsages(fixture, "fixture.ts").map((u) => u.api)).toEqual(["bun:sqlite"]);
  });

  test("side-effect import `import \"bun:sqlite\"` is still detected", () => {
    const fixture = `import "bun:sqlite";`;
    expect(findBunUsages(fixture, "fixture.ts").map((u) => u.api)).toEqual(["bun:sqlite"]);
  });

  test("dynamic-import trap: `import(\"bun:sqlite\")` is detected", () => {
    const fixture = `const db = await import("bun:sqlite");`;
    expect(findBunUsages(fixture, "fixture.ts").map((u) => u.api)).toEqual(["bun:sqlite"]);
  });

  test("src/** contributes zero Bun usages", () => {
    const srcUsages = found.filter((u) => u.location.startsWith("visualizer/src/"));
    expect(srcUsages).toEqual([]);
  });
});
