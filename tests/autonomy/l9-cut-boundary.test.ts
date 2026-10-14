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
 *    the deterministic order;
 *  - (R1-15) the cut itself, executed: the tree is materialised in a tmp dir
 *    WITHOUT L9's two files and `bun test tests/autonomy/` must pass there.
 */
import { describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
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

/** Set in the child run so the materialised tree does not recurse into itself. */
const CUT_CHILD_ENV = "QDS_J4_CUT_CHILD";
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[a-zA-Z]`, "g");

describe("L9 cut, executed (R1-15)", () => {
  test.skipIf(process.env[CUT_CHILD_ENV] === "1")(
    "the autonomy suite is green on a materialised tree with L9's two files deleted",
    () => {
      const tree = mkdtempSync(join(tmpdir(), "qds-j4-cut-"));
      try {
        // The three trees the cut touches or that import across it are COPIED; every other top-level
        // entry (workspaces, oci, config, node_modules) is symlinked read-only. Never .git or outputs.
        const COPY = new Set(["src", "scripts", "tests"]);
        const SKIP = new Set([".git", "_bmad-output", ".unlazy", ".gitnexus", "artifacts"]);
        for (const e of readdirSync(ROOT)) {
          if (SKIP.has(e)) continue;
          if (COPY.has(e)) cpSync(join(ROOT, e), join(tree, e), { recursive: true });
          else symlinkSync(join(ROOT, e), join(tree, e));
        }
        // THE cut: delete the two files, flip nothing else.
        const cut = ["src/autonomy/l9-repo-sweep-triage.ts", "tests/autonomy/l9-repo-sweep-triage.test.ts"];
        for (const f of cut) rmSync(join(tree, f), { force: true });
        for (const f of cut) expect(existsSync(join(tree, f))).toBe(false);
        // `fleet observe --all` (exercised by the suite) refuses a non-worktree cwd.
        expect(Bun.spawnSync(["git", "init", "-q"], { cwd: tree }).exitCode).toBe(0);
        const child = Bun.spawnSync(["bun", "test", "tests/autonomy/"], {
          cwd: tree,
          env: { ...process.env, [CUT_CHILD_ENV]: "1" },
          stdout: "pipe",
          stderr: "pipe",
        });
        const text = `${child.stdout.toString()}${child.stderr.toString()}`.replace(/\r/g, "\n").replace(ANSI, "");
        if (child.exitCode !== 0) throw new Error(`L9-less tree suite failed (exit ${child.exitCode}):\n${text.slice(-4000)}`);
        expect(text).toMatch(/\b0 fail\b/);
        expect(text).toMatch(/\b[1-9]\d* pass\b/);
        expect(text).not.toMatch(/l9-repo-sweep-triage\.test\.ts/);
      } finally {
        rmSync(tree, { recursive: true, force: true });
      }
    },
    300_000,
  );
});
