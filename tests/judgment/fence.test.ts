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
import { join } from "node:path";

const JUDGMENT_SRC = join(import.meta.dir, "..", "..", "src", "judgment");
const ALLOWED_REPO_IMPORTS = new Set(["../lib/http.ts", "../swarmclaw/log.ts"]);

function importSpecifiers(source: string): string[] {
  return [...source.matchAll(/(?:^|\n)\s*import[^"']*["']([^"']+)["']/g)].map((m) => m[1] ?? "");
}

describe("src/judgment import fence", () => {
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
