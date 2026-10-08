/**
 * JudgmentProvider registry tests (v6 J1 AC2, DD-21 seam half).
 *
 * The registry is a module-level closed constant seeded with exactly two
 * adapter makers. Extension is a code change plus contract-suite membership
 * (tests/judgment/adapter-contract.test.ts) — never a runtime call — so this
 * suite pins the closure three ways: the frozen constant refuses every
 * mutation path, the module exports no registration verb, and resolution
 * refuses any id that is not an own key of the constant.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";
import { makeJevProvider } from "../../src/judgment/adapters/jev.ts";
import { makeMockProvider } from "../../src/judgment/adapters/mock.ts";
import * as providerModule from "../../src/judgment/provider.ts";
import {
  JUDGMENT_PROVIDER_IDS,
  JUDGMENT_PROVIDERS,
  resolveProvider,
  UnknownProviderError,
} from "../../src/judgment/provider.ts";

describe("closed registry", () => {
  test("seeded with exactly the two adapters, in a pinned order", () => {
    expect([...JUDGMENT_PROVIDER_IDS]).toEqual(["jev", "mock"]);
    expect(Object.keys(JUDGMENT_PROVIDERS)).toEqual(["jev", "mock"]);
  });

  test("resolveProvider returns the registered adapter makers", () => {
    expect(resolveProvider("jev")).toBe(makeJevProvider);
    expect(resolveProvider("mock")).toBe(makeMockProvider);
  });

  test("the registry constant and its id list are frozen — every mutation path throws", () => {
    expect(Object.isFrozen(JUDGMENT_PROVIDERS)).toBe(true);
    expect(Object.isFrozen(JUDGMENT_PROVIDER_IDS)).toBe(true);
    const registry = JUDGMENT_PROVIDERS as unknown as Record<string, unknown>;
    // ES modules are strict mode: a write to a frozen object throws, it is
    // never a silent no-op.
    expect(() => {
      registry.rogue = makeMockProvider;
    }).toThrow(TypeError);
    expect(() => {
      registry.mock = makeJevProvider;
    }).toThrow(TypeError);
    expect(() => {
      // biome-ignore lint/performance/noDelete: asserting delete is refused
      delete registry.jev;
    }).toThrow(TypeError);
    expect(() => Object.defineProperty(registry, "rogue", { value: makeMockProvider })).toThrow(TypeError);
    expect(() => (JUDGMENT_PROVIDER_IDS as unknown as string[]).push("rogue")).toThrow(TypeError);
    expect(Object.keys(JUDGMENT_PROVIDERS)).toEqual(["jev", "mock"]);
  });

  test("the module exports no registration or mutation verb — only the closed surface", () => {
    // A runtime registerProvider()/addProvider() would let a transport no
    // contract test has run onto the seam (story Technical Notes, rejected).
    expect(Object.keys(providerModule).sort()).toEqual([
      "JUDGMENT_PROVIDERS",
      "JUDGMENT_PROVIDER_IDS",
      "UnknownProviderError",
      "resolveProvider",
    ]);
  });
});

describe("resolveProvider refusal (typed unknown-provider, before any request exists)", () => {
  // Prototype keys are the classic hole in an object-keyed registry: `in` and
  // bracket lookup both see Object.prototype members.
  const unknown = ["", "Jev", "MOCK", "openai", "toString", "constructor", "__proto__", "hasOwnProperty"];

  for (const id of unknown) {
    test(`refuses ${JSON.stringify(id)}`, () => {
      let caught: unknown;
      try {
        resolveProvider(id);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(UnknownProviderError);
      const err = caught as UnknownProviderError;
      expect(err.code).toBe("unknown-provider");
      expect(err.providerId).toBe(id);
      expect(err.message).toContain("jev | mock");
    });
  }

  test("a non-string id refuses typed too (callers at a JSON boundary)", () => {
    expect(() => resolveProvider(undefined as unknown as string)).toThrow(UnknownProviderError);
    expect(() => resolveProvider(1 as unknown as string)).toThrow(UnknownProviderError);
  });
});

describe("adapter makers", () => {
  test("the mock maker takes no configuration at all — no key path is a type fact", () => {
    expect(makeMockProvider.length).toBe(0);
  });

  test("each made adapter is a frozen { id, ask } and nothing else", () => {
    const jev = makeJevProvider({ apiKey: "k", baseUrl: "http://judgment.test", timeoutMs: 1 });
    const mock = makeMockProvider();
    for (const [id, adapter] of [
      ["jev", jev],
      ["mock", mock],
    ] as const) {
      expect(adapter.id).toBe(id);
      expect(Object.keys(adapter).sort()).toEqual(["ask", "id"]);
      expect(typeof adapter.ask).toBe("function");
      expect(Object.isFrozen(adapter)).toBe(true);
    }
  });

  test("the jev adapter never exposes the key it closes over", () => {
    const jev = makeJevProvider({ apiKey: "SECRETKEYVALUE123", baseUrl: "http://judgment.test", timeoutMs: 1 });
    expect(JSON.stringify(jev)).not.toContain("SECRETKEYVALUE123");
    expect(Object.values(jev)).not.toContain("SECRETKEYVALUE123");
  });
});

/**
 * The makers are seam-private: a made adapter's ask() skips the egress choke,
 * the ceiling and the strict parse, so only the seam client (and this
 * directory's tests) may reach provider.ts or adapters/. Repo-wide, by
 * resolved import path AND by maker identifier.
 */
describe("maker reach — seam-private, repo-wide", () => {
  const ROOT = join(import.meta.dir, "..", "..");
  const JUDGMENT = join(ROOT, "src", "judgment");
  const PRIVATE = [join(JUDGMENT, "provider.ts"), join(JUDGMENT, "adapters")];
  const MAKER_NAMES = /^(JUDGMENT_PROVIDERS|resolveProvider|makeJevProvider|makeMockProvider)$/;

  /** Compare module paths the way the resolver does: extension-less, case-folded (macOS). */
  function norm(p: string): string {
    return p.replace(/\.(ts|mts|tsx|js|mjs)$/, "").toLowerCase();
  }
  const PRIVATE_NORM = PRIVATE.map(norm);

  function trackedTs(): string[] {
    const r = spawnSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "*.ts", "*.mts", "*.tsx", "*.js", "*.mjs", "*.cjs"], {
      cwd: ROOT,
      encoding: "utf8",
    });
    return r.stdout
      .split("\0")
      .filter(Boolean)
      .map((f) => join(ROOT, f))
      .filter((f) => existsSync(f));
  }

  /** AST walk: every module edge (static, re-export, import(), require()) and every maker identifier. */
  function reaches(file: string, src: string): string[] {
    const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true);
    const hits: string[] = [];
    const edge = (spec: string): void => {
      if (!spec.startsWith(".")) return;
      const target = norm(resolve(dirname(file), spec));
      if (PRIVATE_NORM.some((p) => target === p || target.startsWith(`${p}/`))) hits.push(`${relative(ROOT, file)} imports ${spec}`);
    };
    const visit = (node: ts.Node): void => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        edge(node.moduleSpecifier.text);
      } else if (
        ts.isImportEqualsDeclaration(node) &&
        ts.isExternalModuleReference(node.moduleReference) &&
        ts.isStringLiteral(node.moduleReference.expression)
      ) {
        edge(node.moduleReference.expression.text);
      } else if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require"))
      ) {
        const arg = node.arguments[0];
        if (arg && ts.isStringLiteralLike(arg)) edge(arg.text);
        // a computed specifier cannot be proven safe — refuse it in reach of the makers
        else if (arg && /judgment/i.test(arg.getText())) hits.push(`${relative(ROOT, file)} computes an import of ${arg.getText()}`);
      } else if (ts.isIdentifier(node) && MAKER_NAMES.test(node.text)) {
        hits.push(`${relative(ROOT, file)} names ${node.text}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    return hits;
  }

  test("controls: the reach check flags a direct import, a dynamic import and a maker name", () => {
    const f = join(ROOT, "scripts", "x.ts");
    expect(reaches(f, 'import { resolveProvider } from "../src/judgment/index.ts";').length).toBe(1);
    expect(reaches(f, 'const m = await import("../src/judgment/adapters/jev.ts");').length).toBe(1);
    expect(reaches(f, 'export * from "../src/judgment/provider.ts";').length).toBe(1);
    expect(reaches(f, 'import { JudgmentClient } from "../src/judgment/index.ts";')).toEqual([]);
    // resolver-equivalent spellings, and text inside strings/comments is not code
    expect(reaches(f, 'export * from "../src/judgment/provider";').length).toBe(1);
    expect(reaches(f, 'import * as p from "../src/judgment/provider.js";').length).toBe(1);
    expect(reaches(f, 'export * from "../src/Judgment/Provider.ts";').length).toBe(1);
    expect(reaches(f, 'const s = "a//"; resolveProvider("jev");').length).toBe(1);
    expect(reaches(f, '// resolveProvider is seam-private\nconst s = "resolveProvider";')).toEqual([]);
    expect(reaches(f, 'import p = require("../src/judgment/provider.ts");').length).toBe(1);
    expect(reaches(f, 'const m = await import(`../src/judgment/${"provider"}.ts`);').length).toBe(1);
  });

  test("outside src/judgment/ and tests/judgment/, nothing reaches the makers", () => {
    const allowed = [JUDGMENT, join(ROOT, "tests", "judgment")];
    const files = trackedTs().filter((f) => !allowed.some((a) => f.startsWith(`${a}/`)));
    expect(files.length).toBeGreaterThan(100); // not vacuous
    const hits = files.flatMap((f) => reaches(f, readFileSync(f, "utf8")));
    expect(hits).toEqual([]);
  });

  test("the public barrel exposes ids + typed refusal, never a maker", async () => {
    const barrel = await import("../../src/judgment/index.ts");
    expect(Object.keys(barrel)).toContain("JUDGMENT_PROVIDER_IDS");
    expect(Object.keys(barrel)).toContain("UnknownProviderError");
    expect(Object.keys(barrel)).not.toContain("JUDGMENT_PROVIDERS");
    expect(Object.keys(barrel)).not.toContain("resolveProvider");
  });

  test("inside src/judgment/, only client.ts reaches the registry (adapters are made by the seam alone)", () => {
    const users = readdirSync(JUDGMENT, { recursive: true, encoding: "utf8" })
      .filter((f) => f.endsWith(".ts") && f !== "provider.ts" && !f.startsWith("adapters"))
      .filter((f) => reaches(join(JUDGMENT, f), readFileSync(join(JUDGMENT, f), "utf8")).some((h) => / names (resolveProvider|JUDGMENT_PROVIDERS)$/.test(h)));
    expect(users).toEqual(["client.ts"]);
  });

  test("UnknownProviderError formats every id without throwing (BigInt, cyclic)", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    for (const id of [10n, cyclic, Symbol("s"), null]) {
      expect(() => resolveProvider(id as unknown as string)).toThrow(UnknownProviderError);
    }
  });
});
