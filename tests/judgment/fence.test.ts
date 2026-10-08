/**
 * Two-import fence test (JEV-2 INV-J4, handoff §11 resolution 2).
 *
 * `src/judgment/` imports ONLY `src/lib/http.ts` + `src/swarmclaw/log.ts`
 * (repo-internal) plus `zod` (external) and its own siblings. This is the
 * grep-level assertion of the fence — it keeps the providers/audit/gate
 * surfaces structurally unreachable from the judgment core, and keeps the
 * §3.8 ban on importing `redactSecrets` from ever regressing.
 *
 * The fence binds src/judgment/ itself, not its callers (scripts/judgment/
 * and tests/judgment/ may import src/judgment/ freely).
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const JUDGMENT_SRC = join(import.meta.dir, "..", "..", "src", "judgment");
const ALLOWED_REPO_IMPORTS = new Set(["../lib/http.ts", "../swarmclaw/log.ts"]);

function importSpecifiers(source: string): string[] {
  // Both module edges: import-from AND export-from — a re-export is an import
  // edge, and index.ts's entire public surface is export-from, which an
  // import-only regex never scanned. Bare side-effect imports (`import "./x"`)
  // are kept.
  return [
    ...source.matchAll(/(?:^|\n)\s*(?:import|export)\b[^"']*?\bfrom\s*["']([^"']+)["']/g),
    ...source.matchAll(/(?:^|\n)\s*import\s*["']([^"']+)["']/g),
  ].map((m) => m[1] ?? "");
}

describe("src/judgment import fence", () => {
  test("importSpecifiers covers import-from, export-from, and bare side-effect edges", () => {
    // Pins the scanner: export-from is the edge index.ts uses exclusively.
    expect(importSpecifiers('export * from "../providers/x.ts";')).toContain("../providers/x.ts");
    expect(importSpecifiers('export { y } from "./y.ts";')).toContain("./y.ts");
    expect(importSpecifiers('import { z } from "zod";')).toContain("zod");
    expect(importSpecifiers('import "./side-effect.ts";')).toContain("./side-effect.ts");
  });

  test("every module imports only http.ts, swarmclaw/log.ts, zod, or its own siblings", () => {
    const violations: string[] = [];
    for (const file of readdirSync(JUDGMENT_SRC)) {
      if (!file.endsWith(".ts")) continue;
      const source = readFileSync(join(JUDGMENT_SRC, file), "utf8");
      for (const spec of importSpecifiers(source)) {
        const inModule = spec.startsWith("./") && spec.endsWith(".ts");
        const allowed =
          spec === "zod" ||
          spec.startsWith("node:") ||
          inModule ||
          (spec.startsWith("../") && ALLOWED_REPO_IMPORTS.has(spec));
        if (!allowed) violations.push(`${file}: "${spec}"`);
      }
    }
    expect(violations).toEqual([]);
  });

  test("no providers / redactSecrets / audit / gate symbol is ever imported", () => {
    // Structural, not prose: the ban is on import edges (doc comments may
    // still explain WHY a symbol is not used), so this walks specifiers.
    for (const file of readdirSync(JUDGMENT_SRC)) {
      if (!file.endsWith(".ts")) continue;
      const source = readFileSync(join(JUDGMENT_SRC, file), "utf8");
      const specifiers = importSpecifiers(source).join("\n");
      expect(specifiers).not.toMatch(
        /redactSecrets|providers|audit|gate-runner|classifyRunExit|classifyDiffScope/,
      );
    }
  });
});

/**
 * v6 J1 AC5 — the fence walks src/judgment/ RECURSIVELY, adapters/ included.
 * Specifiers are resolved against the importing file, so `../../lib/http.ts`
 * from adapters/ is the same allowed edge as `../lib/http.ts` from the root,
 * and a sibling edge is any path that stays inside src/judgment/.
 */
const SRC = join(JUDGMENT_SRC, "..");
const ALLOWED_REPO_TARGETS = new Set([join(SRC, "lib", "http.ts"), join(SRC, "swarmclaw", "log.ts")]);

function judgmentFiles(): string[] {
  return readdirSync(JUDGMENT_SRC, { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".ts"))
    .map((f) => join(JUDGMENT_SRC, f));
}

/** Static edges plus the dynamic ones a static-only scan misses: import() and require(). */
function allSpecifiers(source: string): string[] {
  return [
    ...importSpecifiers(source),
    ...[...source.matchAll(/\bimport\s*\(\s*["'`]([^"'`]+)["'`]/g)].map((m) => m[1] ?? ""),
    ...[...source.matchAll(/\brequire\s*\(\s*["'`]([^"'`]+)["'`]/g)].map((m) => m[1] ?? ""),
  ];
}

function fenceViolations(file: string, source: string): string[] {
  const out: string[] = [];
  for (const spec of allSpecifiers(source)) {
    if (spec === "zod" || spec.startsWith("node:")) continue;
    if (!spec.startsWith(".")) {
      out.push(`${relative(JUDGMENT_SRC, file)}: "${spec}"`);
      continue;
    }
    const target = resolve(dirname(file), spec);
    const inModule = target.startsWith(`${JUDGMENT_SRC}/`) && target.endsWith(".ts");
    if (!inModule && !ALLOWED_REPO_TARGETS.has(target)) out.push(`${relative(JUDGMENT_SRC, file)}: "${spec}"`);
  }
  return out;
}

describe("src/judgment import fence — recursive (J1)", () => {
  test("the recursive walk reaches adapters/ (it is not vacuous)", () => {
    const rel = judgmentFiles().map((f) => relative(JUDGMENT_SRC, f));
    expect(rel).toContain(join("adapters", "jev.ts"));
    expect(rel).toContain(join("adapters", "mock.ts"));
    expect(rel).toContain("provider.ts");
  });

  test("resolved-path fence: positive and negative controls", () => {
    const adapter = join(JUDGMENT_SRC, "adapters", "x.ts");
    expect(fenceViolations(adapter, 'import { httpRequest } from "../../lib/http.ts";')).toEqual([]);
    expect(fenceViolations(adapter, 'import type { JudgmentRequest } from "../schemas.ts";')).toEqual([]);
    expect(fenceViolations(adapter, 'export * from "../../providers/run-record.ts";').length).toBe(1);
    expect(fenceViolations(adapter, 'import { x } from "../../audit/link-store.ts";').length).toBe(1);
    expect(fenceViolations(adapter, 'import { x } from "@typesafe/sdk";').length).toBe(1);
    expect(fenceViolations(adapter, 'const p = await import("../../providers/run-record.ts");').length).toBe(1);
    expect(fenceViolations(adapter, 'const a = require("../../audit/link-store.ts");').length).toBe(1);
  });

  test("every module at every depth imports only http.ts, swarmclaw/log.ts, zod, node:, or src/judgment/ itself", () => {
    const violations = judgmentFiles().flatMap((f) => fenceViolations(f, readFileSync(f, "utf8")));
    expect(violations).toEqual([]);
  });

  test("no providers / redactSecrets / audit / gate symbol is imported at any depth", () => {
    for (const file of judgmentFiles()) {
      const specifiers = allSpecifiers(readFileSync(file, "utf8")).join("\n");
      expect(specifiers).not.toMatch(/redactSecrets|providers|audit|gate-runner|classifyRunExit|classifyDiffScope/);
    }
  });
});
