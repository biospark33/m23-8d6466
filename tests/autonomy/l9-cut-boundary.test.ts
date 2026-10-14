/**
 * J4 — the L9 cut contract. This suite SURVIVES the cut: it passes whether or
 * not L9's two files (src/autonomy/l9-repo-sweep-triage.ts and its test)
 * exist. The cut is: delete those two files, flip nothing else.
 *
 *  - zero import edges from any src/ or scripts/ module (other than the L9
 *    module itself) into the L9 module path — static, re-export, import(),
 *    computed import(), require();
 *  - host-pack.ts and host-pack.test.ts carry no L9 string at all;
 *  - the fallback consumer path (`orderSweepHotspots` with no ranker) returns
 *    the deterministic order.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";
import { orderSweepHotspots, type SweepHotspot } from "../../src/autonomy/host-pack.ts";

const ROOT = join(import.meta.dir, "..", "..");
const L9_MODULE = join(ROOT, "src", "autonomy", "l9-repo-sweep-triage");
const norm = (p: string): string => p.replace(/\.(ts|mts|cts|tsx|js|mjs|cjs)$/, "").toLowerCase();

function codeUnder(dir: string): string[] {
  return readdirSync(join(ROOT, dir), { recursive: true, encoding: "utf8" })
    .filter((f) => /\.(ts|mts|cts|js|mjs|cjs)$/.test(f) && !f.includes("node_modules"))
    .map((f) => join(ROOT, dir, f));
}

/** Every module edge from `file` that lands on the L9 module (or computes a specifier naming it). */
function l9Edges(file: string, src: string): string[] {
  const hits: string[] = [];
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true);
  const edge = (spec: string): void => {
    if (spec.startsWith(".") && norm(resolve(dirname(file), spec)) === norm(L9_MODULE)) hits.push(`${relative(ROOT, file)} -> ${spec}`);
  };
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      edge(node.moduleSpecifier.text);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && ts.isStringLiteral(node.moduleReference.expression)) {
      edge(node.moduleReference.expression.text);
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    ) {
      const arg = node.arguments[0];
      if (arg && ts.isStringLiteralLike(arg)) edge(arg.text);
      else if (arg && /repo-sweep|l9/i.test(arg.getText())) hits.push(`${relative(ROOT, file)} computes ${arg.getText()}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

describe("L9 cut boundary (survives the cut)", () => {
  test("no src/ or scripts/ module except L9 itself imports the L9 module", () => {
    const files = [...codeUnder("src"), ...codeUnder("scripts")].filter((f) => norm(f) !== norm(L9_MODULE));
    expect(files.length).toBeGreaterThan(100); // not vacuous
    expect(files.flatMap((f) => l9Edges(f, readFileSync(f, "utf8")))).toEqual([]);
  });

  test("controls: the edge walk flags static, re-export, dynamic, computed and require edges", () => {
    const f = join(ROOT, "src", "autonomy", "host-pack.ts");
    expect(l9Edges(f, 'import { makeSweepTriageRanker } from "./l9-repo-sweep-triage.ts";')).toHaveLength(1);
    expect(l9Edges(f, 'export * from "./l9-repo-sweep-triage";')).toHaveLength(1);
    expect(l9Edges(f, 'const m = await import("./l9-repo-sweep-triage.ts");')).toHaveLength(1);
    expect(l9Edges(f, 'const n = "triage"; const m = await import(`./l9-repo-sweep-${n}.ts`);')).toHaveLength(1);
    expect(l9Edges(join(ROOT, "scripts", "x.ts"), 'const m = require("../src/autonomy/l9-repo-sweep-triage.ts");')).toHaveLength(1);
    expect(l9Edges(f, 'import { log } from "../lib/log.ts";')).toEqual([]);
  });

  test("pack core carries no L9 string: host-pack.ts and host-pack.test.ts", () => {
    for (const p of ["src/autonomy/host-pack.ts", "tests/autonomy/host-pack.test.ts"]) {
      expect(/l9/i.test(readFileSync(join(ROOT, p), "utf8"))).toBe(false);
    }
  });

  test("fallback consumer path: no ranker ⇒ deterministic order (score desc, path asc)", async () => {
    const hs: SweepHotspot[] = [
      { path: "src/b.ts", brief: "b", score: 2 },
      { path: "src/a.ts", brief: "a", score: 2 },
      { path: "src/c.ts", brief: "c", score: 5 },
      { path: "src/d.ts", brief: "d", score: 0 },
    ];
    expect((await orderSweepHotspots(hs)).map((h) => h.path)).toEqual(["src/c.ts", "src/a.ts", "src/b.ts", "src/d.ts"]);
    expect((await orderSweepHotspots([])).length).toBe(0);
  });
});
