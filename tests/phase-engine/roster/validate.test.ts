/**
 * DF1.5 — dual slug gates, rate resolution, unit conversion, exit codes.
 *
 * AC1 (both gates, neither skippable), AC3 (partial cost block), AC4 (catalog
 * that exits 0 while printing "No models available" → unverified, exit 2),
 * AC5 (missing models.json = empty registry), AC6 (resolveRate contract,
 * precedence, units, unpriced rejection), INV-1/3/4.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatReport } from "../../../scripts/roster-check.ts";
import { parseRoster } from "../../../src/phase-engine/roster/schema.ts";
import {
  type CatalogProbe,
  type ProviderProbe,
  type RateSources,
  type RateTable,
  findBundledCatalogDir,
  loadBundledCatalog,
  parsePiModelTable,
  PI_PINNED_VERSION_PREFIX,
  probePiCatalog,
  probeProviderModels,
  RateError,
  readCustomRegistry,
  resetRateSources,
  resolveRate,
  toMicrosPerMTok,
  validateRoster,
} from "../../../src/phase-engine/roster/validate.ts";

/**
 * `prev ?? ""` would restore an unset var as an EMPTY string, not unset it —
 * and both `defaultCustomRegistryPath` and `findBundledCatalogDir` treat an
 * empty override as a real (if bogus) path, not "no override". That makes a
 * later test read a stale `""` path instead of the host default, order-
 * dependently. Delete when the saved value was undefined.
 */
function restoreEnv(name: string, prev: string | undefined): void {
  if (prev === undefined) delete process.env[name];
  else process.env[name] = prev;
}

// --- fixtures ---------------------------------------------------------------

const ROSTER = `
defaults:
  provider: openrouter
  writes: []
roles:
  - name: planner
    model: anthropic/claude-haiku-4.5
`;

function table(entries: Record<string, object>, unit: RateTable["unit"] = "usd-per-mtok"): RateTable {
  return { unit, entries: new Map(Object.entries(entries)) };
}

const SOURCES: RateSources = {
  bundled: table({ "openrouter/anthropic/claude-haiku-4.5": { input: 1, output: 5 } }),
  custom: table({}),
};

function catalog(pairs: string[]): () => Promise<CatalogProbe> {
  return async () => ({ ok: true, pairs: new Set(pairs), durationMs: 3 });
}
const catalogDown: () => Promise<CatalogProbe> = async () => ({
  ok: false,
  pairs: new Set<string>(),
  reason: "pi --list-models printed 'No models available'",
  durationMs: 0,
});

function provider(ids: string[]): () => Promise<ProviderProbe> {
  return async () => ({ ok: true, ids: new Set(ids), durationMs: 4 });
}
const providerDown: () => Promise<ProviderProbe> = async () => ({
  ok: false,
  ids: new Set<string>(),
  reason: "https://openrouter.ai/api/v1/models answered 503",
  durationMs: 0,
});

const LIVE = ["anthropic/claude-haiku-4.5"];
const CAT = ["openrouter/anthropic/claude-haiku-4.5"];

// --- AC1: both gates --------------------------------------------------------

describe("AC1 — every slug is checked against BOTH gates", () => {
  test("passing both gates exits 0 and records both verdicts", async () => {
    const r = await validateRoster(parseRoster(ROSTER), {
      probeCatalog: catalog(CAT),
      probeProvider: provider(LIVE),
      rateSources: SOURCES,
    });
    expect(r.exitCode).toBe(0);
    expect(r.roles[0]!.piCatalog).toBe("pass");
    expect(r.roles[0]!.providerApi).toBe("pass");
    expect(r.roles[0]!.problems).toEqual([]);
  });

  test("a slug the PROVIDER does not list is rejected naming the provider gate", async () => {
    const r = await validateRoster(parseRoster(ROSTER), {
      probeCatalog: catalog(CAT),
      probeProvider: provider(["something/else"]),
      rateSources: SOURCES,
    });
    expect(r.exitCode).toBe(1);
    expect(r.roles[0]!.piCatalog).toBe("pass");
    expect(r.roles[0]!.providerApi).toBe("fail");
    expect(r.roles[0]!.problems.join("\n")).toContain("provider-API gate");
  });

  test("a slug the CATALOG does not list is rejected naming the catalog gate", async () => {
    const r = await validateRoster(parseRoster(ROSTER), {
      probeCatalog: catalog(["openrouter/other"]),
      probeProvider: provider(LIVE),
      rateSources: SOURCES,
    });
    expect(r.exitCode).toBe(1);
    expect(r.roles[0]!.piCatalog).toBe("fail");
    expect(r.roles[0]!.providerApi).toBe("pass");
    expect(r.roles[0]!.problems.join("\n")).toContain("pi-catalog gate");
  });

  test("a rejected role is not priced — the gate verdict is the headline", async () => {
    const r = await validateRoster(parseRoster(ROSTER), {
      probeCatalog: catalog(CAT),
      probeProvider: provider([]),
      rateSources: SOURCES,
    });
    expect(r.roles[0]!.rate).toBeNull();
    expect(r.roles[0]!.source).toBeNull();
  });

  test("the catalog gate names both readings when a model prefix contradicts provider", async () => {
    const src = `
roles:
  - name: flash
    provider: openrouter
    model: anthropic/claude-haiku-4.5
    writes: []
`;
    const r = await validateRoster(parseRoster(src), {
      // The catalog lists the model under `anthropic`, NOT under `openrouter`.
      probeCatalog: catalog(["anthropic/claude-haiku-4.5"]),
      probeProvider: provider(LIVE),
      rateSources: SOURCES,
    });
    expect(r.roles[0]!.piCatalog).toBe("fail");
    const msg = r.roles[0]!.problems.join("\n");
    // BOTH readings are named — the declared pair and the split one. The second
    // assertion needs a delimiter, or it is just a substring of the first.
    expect(msg).toContain('"openrouter/anthropic/claude-haiku-4.5"');
    expect(msg).toContain('"anthropic/claude-haiku-4.5" exists');
    expect(msg).toContain("contradicts");
    expect(r.exitCode).toBe(1);
  });

  test("the two gates are memoized: one catalog call, one call per provider", async () => {
    let catalogCalls = 0;
    const providerCalls: string[] = [];
    const src = `
defaults:
  writes: []
roles:
  - name: a
    provider: openrouter
    model: m1
  - name: b
    provider: openrouter
    model: m2
  - name: c
    provider: fifer-ai
    model: m3
`;
    await validateRoster(parseRoster(src), {
      probeCatalog: async () => {
        catalogCalls++;
        return { ok: true, pairs: new Set<string>(), durationMs: 1 };
      },
      probeProvider: async (p) => {
        providerCalls.push(p);
        return { ok: true, ids: new Set<string>(), durationMs: 1 };
      },
      rateSources: SOURCES,
    });
    expect(catalogCalls).toBe(1);
    expect(providerCalls).toEqual(["openrouter", "fifer-ai"]);
  });
});

// --- AC4 / INV-4: unverified, and 2 dominates 1 -----------------------------

describe("AC4 / INV-4 — unverified is never a pass, and 2 dominates 1", () => {
  test("catalog unverified leaves the provider verdict intact and exits 2", async () => {
    const src = `
defaults:
  provider: openrouter
  writes: []
roles:
  - name: good
    model: anthropic/claude-haiku-4.5
  - name: bad
    model: does-not-exist
`;
    const r = await validateRoster(parseRoster(src), {
      probeCatalog: catalogDown,
      probeProvider: provider(LIVE),
      rateSources: SOURCES,
    });
    expect(r.roles[0]!.piCatalog).toBe("unverified");
    expect(r.roles[1]!.piCatalog).toBe("unverified");
    // The sibling gate keeps its REAL verdict — one dead gate does not blank
    // the other.
    expect(r.roles[0]!.providerApi).toBe("pass");
    expect(r.roles[1]!.providerApi).toBe("fail");
    // 2 dominates 1, and the rejection is still listed.
    expect(r.exitCode).toBe(2);
    expect(r.roles[1]!.problems.join("\n")).toContain("provider-API gate rejected");
    expect(r.catalogProbeMs).toBe(0);
  });

  test("a non-200 provider API makes every slug unverified and exits 2", async () => {
    const r = await validateRoster(parseRoster(ROSTER), {
      probeCatalog: catalog(CAT),
      probeProvider: providerDown,
      rateSources: SOURCES,
    });
    expect(r.roles[0]!.providerApi).toBe("unverified");
    expect(r.roles[0]!.piCatalog).toBe("pass");
    expect(r.exitCode).toBe(2);
    expect(r.providerProbeMs).toBe(0);
  });

  test("both gates unverified still exits 2, never 0", async () => {
    const r = await validateRoster(parseRoster(ROSTER), {
      probeCatalog: catalogDown,
      probeProvider: providerDown,
      rateSources: SOURCES,
    });
    expect(r.exitCode).toBe(2);
  });

  test("an UNREADABLE models.json is exit 2, not 1 — every gate says pass", async () => {
    // A permission-denied registry is an unavailable control, not "your slugs
    // are bad". Collapsing it into `problems` would report exit 1 while both
    // gates pass.
    const r = await validateRoster(parseRoster(ROSTER), {
      probeCatalog: catalog(CAT),
      probeProvider: provider(LIVE),
      rateSources: SOURCES,
      registryUnavailable: ["~/.pi/agent/models.json: cannot read: EACCES"],
    });
    expect(r.roles[0]!.piCatalog).toBe("pass");
    expect(r.roles[0]!.providerApi).toBe("pass");
    expect(r.exitCode).toBe(2);
    expect(r.problems.join("\n")).toContain("EACCES");
  });

  test("an unreadable registry does NOT fall through to a bundled rate", async () => {
    // models.json is authoritative under AC6, so resolving from the loser table
    // would record a definite `source: bundled` price for a slug whose
    // authoritative price was never read — a correct-looking record built on a
    // control that failed.
    const registry = join(mkdtempSync(join(tmpdir(), "registry-dir-")), "models.json");
    mkdirSync(registry); // a directory where a file is expected → EISDIR on read
    const catalogDir = mkdtempSync(join(tmpdir(), "catalog-real-"));
    writeFileSync(
      join(catalogDir, "openrouter.json"),
      JSON.stringify({
        api: { "anthropic/claude-haiku-4.5": { cost: { input: 1, output: 5 } } },
      }),
    );
    const prevReg = process.env.QDS_PI_MODELS_JSON;
    const prevDir = process.env.QDS_PI_CATALOG_DIR;
    process.env.QDS_PI_MODELS_JSON = registry;
    process.env.QDS_PI_CATALOG_DIR = catalogDir;
    try {
      const r = await validateRoster(parseRoster(ROSTER), {
        probeCatalog: catalog(CAT),
        probeProvider: provider(LIVE),
      });
      expect(r.exitCode).toBe(2);
      expect(r.roles[0]!.rate).toBeNull();
      expect(r.roles[0]!.source).toBeNull();
      expect(r.roles[0]!.problems.join("\n")).toContain("rate unverified");
    } finally {
      restoreEnv("QDS_PI_MODELS_JSON", prevReg);
      restoreEnv("QDS_PI_CATALOG_DIR", prevDir);
    }
  });

  test("an unlocatable bundled catalog is exit 2 (INV-4), not exit 1", async () => {
    // No `rateSources` injected, so validateRoster loads them itself and the
    // real INV-4 branch runs.
    const prev = process.env.QDS_PI_CATALOG_DIR;
    process.env.QDS_PI_CATALOG_DIR = join(tmpdir(), "df15-no-such-catalog-dir");
    try {
      const r = await validateRoster(parseRoster(ROSTER), {
        probeCatalog: catalog(CAT),
        probeProvider: provider(LIVE),
      });
      expect(r.exitCode).toBe(2);
      expect(r.problems.join("\n")).toContain("catalog could not be located");
      expect(r.roles[0]!.rate).toBeNull();
    } finally {
      restoreEnv("QDS_PI_CATALOG_DIR", prev);
    }
  });
});

const HEADER = "provider    model                         context  max-out  thinking  images";

describe("parsePiModelTable", () => {
  test("parses the fixed-width table, skips the header, keeps alias forms", () => {
    const out = [
      HEADER,
      "fifer-ai    fifer                         199K     8K       yes       no",
      "openrouter  anthropic/claude-haiku-4.5    200K     64K      yes       yes",
      "openrouter  ~anthropic/claude-opus-latest  1M      128K     yes       yes",
      "",
    ].join("\n");
    const pairs = parsePiModelTable(out);
    expect(pairs.has("fifer-ai/fifer")).toBe(true);
    expect(pairs.has("openrouter/anthropic/claude-haiku-4.5")).toBe(true);
    // Both the alias-marked and unmarked forms are spawnable.
    expect(pairs.has("openrouter/~anthropic/claude-opus-latest")).toBe(true);
    expect(pairs.has("openrouter/anthropic/claude-opus-latest")).toBe(true);
    expect(pairs.has("provider/model")).toBe(false);
  });

  test("'No models available' yields no pairs (never an empty-catalog pass)", () => {
    expect(parsePiModelTable("No models available\n").size).toBe(0);
  });

  test("banner and error lines before the header are not mistaken for models", () => {
    const out = [
      "Refreshing  catalogs...",
      "error:  openrouter  auth failed",
      HEADER,
      "fifer-ai    fifer                         199K     8K       yes       no",
    ].join("\n");
    const pairs = parsePiModelTable(out);
    expect([...pairs]).toEqual(["fifer-ai/fifer"]);
  });

  test("ANSI colour around the columns does not corrupt the pair", () => {
    const out = [
      HEADER,
      "[1mfifer-ai[0m    [36mfifer[0m    199K     8K       yes       no",
    ].join("\n");
    expect(parsePiModelTable(out).has("fifer-ai/fifer")).toBe(true);
  });

  test("a row with a blank interior cell is still parsed, not dropped", () => {
    // A blank fixed-width cell collapses into the surrounding gutter, so the row
    // arrives with fewer columns. Dropping it would leave the gate `ok` while a
    // live slug went missing — rejecting that role at exit 1 instead of
    // reporting the gate unevaluable at exit 2.
    const out = [
      HEADER,
      "openrouter  anthropic/claude-haiku-4.5    200K     64K",
      "openrouter  deepseek/deepseek-v3.2        163.8K   65.5K    yes",
    ].join("\n");
    const pairs = parsePiModelTable(out);
    expect(pairs.has("openrouter/anthropic/claude-haiku-4.5")).toBe(true);
    expect(pairs.has("openrouter/deepseek/deepseek-v3.2")).toBe(true);
  });

  test("prose after the table is not admitted as a model pair", () => {
    const out = [
      HEADER,
      "fifer-ai    fifer                         199K     8K       yes       no",
      "",
      "Totals:  1220",
      "Use  openrouter/does-not-exist  to  spawn",
    ].join("\n");
    expect([...parsePiModelTable(out)]).toEqual(["fifer-ai/fifer"]);
  });

  test("a gutter narrowing to one space yields ZERO pairs, not wrong ones", () => {
    // The caller reads an empty set as an unevaluable gate (exit 2). Returning
    // a partial set would reject every live slug as a roster defect (exit 1).
    const out = ["provider model context max-out thinking images", "fifer-ai fifer 199K 8K yes no"].join(
      "\n",
    );
    expect(parsePiModelTable(out).size).toBe(0);
  });
});

// --- the gates' OWN logic (not the stubs the other tests inject) ------------

describe("probePiCatalog — the gate's own logic", () => {
  const version = { code: 0, stdout: "0.55.4\n", timedOut: false };

  test("exit 0 + 'No models available' is UNVERIFIED, never a pass", async () => {
    // An implementation that gates on `$?` passes this broken host and MUST
    // fail this test.
    const probe = await probePiCatalog(async (args) =>
      args[0] === "--version" ? version : { code: 0, stdout: "No models available\n", timedOut: false },
    );
    expect(probe.ok).toBe(false);
    expect(probe.pairs.size).toBe(0);
    expect(probe.durationMs).toBe(0);
    expect(probe.reason).toContain("No models available");
  });

  test("a TRUNCATED model table is UNVERIFIED, not a partial model set", async () => {
    // A prefix of the table parses to real-looking rows with real slugs
    // MISSING — which rejects those roles (exit 1) instead of reporting the
    // gate unevaluable (exit 2).
    const probe = await probePiCatalog(async (args) =>
      args[0] === "--version"
        ? version
        : {
            code: 0,
            stdout: "provider  model  context  max-out  thinking  images\nopenrouter  x/y  1  1  no  no\n",
            timedOut: false,
            truncated: true,
          },
    );
    expect(probe.ok).toBe(false);
    expect(probe.pairs.size).toBe(0);
    expect(probe.reason).toContain("capture cap");
  });

  test("exit 0 with an unparseable table is UNVERIFIED, not an empty pass", async () => {
    const probe = await probePiCatalog(async (args) =>
      args[0] === "--version" ? version : { code: 0, stdout: "totally unexpected\n", timedOut: false },
    );
    expect(probe.ok).toBe(false);
    expect(probe.reason).toContain("no model rows");
  });

  test("a timeout is UNVERIFIED and named as such, not an empty catalog", async () => {
    const probe = await probePiCatalog(async (args) =>
      args[0] === "--version" ? version : { code: 0, stdout: "", timedOut: true },
    );
    expect(probe.ok).toBe(false);
    expect(probe.reason).toContain("timed out");
  });

  test("a missing or unparseable pi is UNVERIFIED and echoes no stdout", async () => {
    const missing = await probePiCatalog(async () => {
      throw new Error("spawn pi ENOENT");
    });
    expect(missing.ok).toBe(false);
    expect(missing.reason).toContain("unavailable");

    const junk = await probePiCatalog(async () => ({
      code: 0,
      stdout: "SECRETish garbage\n",
      timedOut: false,
    }));
    expect(junk.ok).toBe(false);
    expect(junk.reason).not.toContain("SECRETish");
  });

  test("a good run passes, and version drift warns without failing the gate", async () => {
    const rows = `${HEADER}\nfifer-ai    fifer                         199K     8K       yes       no`;
    const pinned = await probePiCatalog(async (args) =>
      args[0] === "--version" ? version : { code: 0, stdout: rows, timedOut: false },
    );
    expect(pinned.ok).toBe(true);
    expect(pinned.warnings ?? []).toEqual([]);

    const drifted = await probePiCatalog(async (args) =>
      args[0] === "--version"
        ? { code: 0, stdout: "0.84.1\n", timedOut: false }
        : { code: 0, stdout: rows, timedOut: false },
    );
    expect(drifted.ok).toBe(true);
    expect(drifted.warnings?.join("")).toContain(PI_PINNED_VERSION_PREFIX);
  });

  test("the version-drift warning survives a later catalog failure", async () => {
    const probe = await probePiCatalog(async (args) =>
      args[0] === "--version"
        ? { code: 0, stdout: "0.84.1\n", timedOut: false }
        : { code: 0, stdout: "No models available\n", timedOut: false },
    );
    expect(probe.ok).toBe(false);
    expect(probe.warnings?.join("")).toContain("0.84.1");
  });
});

describe("probeProviderModels — the gate's own logic", () => {
  const ok = (ids: string[]) =>
    new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), { status: 200 });

  test("a 200 with a non-empty data[] passes", async () => {
    const probe = await probeProviderModels("openrouter", async () => ok(["a/b"]));
    expect(probe.ok).toBe(true);
    expect(probe.ids.has("a/b")).toBe(true);
  });

  test("a non-200 is UNVERIFIED, never a pass — and is NOT retried", async () => {
    let calls = 0;
    const probe = await probeProviderModels("openrouter", async () => {
      calls++;
      return new Response("nope", { status: 503 });
    });
    expect(probe.ok).toBe(false);
    expect(probe.reason).toContain("503");
    // A server that answered has given its answer.
    expect(calls).toBe(1);
  });

  test("an empty data[] is UNVERIFIED, never an empty-list pass", async () => {
    const probe = await probeProviderModels("openrouter", async () => ok([]));
    expect(probe.ok).toBe(false);
    expect(probe.reason).toContain("empty");
  });

  test("unparseable JSON is UNVERIFIED", async () => {
    const probe = await probeProviderModels(
      "openrouter",
      async () => new Response("<html>", { status: 200 }),
    );
    expect(probe.ok).toBe(false);
    expect(probe.reason).toContain("JSON");
  });

  test("a network error is retried exactly once, then UNVERIFIED", async () => {
    let calls = 0;
    const flaky = await probeProviderModels("openrouter", async () => {
      calls++;
      if (calls === 1) throw new Error("ECONNRESET");
      return ok(["a/b"]);
    });
    expect(flaky.ok).toBe(true);
    expect(calls).toBe(2);

    let dead = 0;
    const down = await probeProviderModels("openrouter", async () => {
      dead++;
      throw new Error("ECONNRESET");
    });
    expect(down.ok).toBe(false);
    expect(dead).toBe(2);
    expect(down.reason).toContain("ECONNRESET");
  });

  test("an unconfigured provider is UNVERIFIED, never a pass by omission", async () => {
    let called = false;
    const probe = await probeProviderModels("anthropic", async () => {
      called = true;
      return ok(["x"]);
    });
    expect(probe.ok).toBe(false);
    expect(called).toBe(false);
    expect(probe.reason).toContain("anthropic");
  });
});

// --- AC3 / INV-3: models.json cost block ------------------------------------

describe("AC3 / INV-3 — models.json cost blocks are complete or rejected", () => {
  function registry(doc: unknown) {
    const dir = mkdtempSync(join(tmpdir(), "models-json-"));
    const p = join(dir, "models.json");
    writeFileSync(p, JSON.stringify(doc));
    return readCustomRegistry(p);
  }

  test("an entry omitting cacheWrite is rejected naming cacheWrite, exit 1", async () => {
    const { table: t, problems } = registry({
      providers: {
        openrouter: {
          models: [
            {
              id: "anthropic/claude-haiku-4.5",
              cost: { input: 1, output: 5, cacheRead: 0.1 },
            },
          ],
        },
      },
    });
    expect(problems.join("\n")).toContain("cacheWrite");
    expect(t.entries.size).toBe(0);

    const r = await validateRoster(parseRoster(ROSTER), {
      probeCatalog: catalog(CAT),
      probeProvider: provider(LIVE),
      rateSources: SOURCES,
      registryProblems: problems,
    });
    expect(r.exitCode).toBe(1);
    expect(r.problems.join("\n")).toContain("cacheWrite");
  });

  test("every missing key is named, not just the first", () => {
    const { problems } = registry({
      providers: { p: { models: [{ id: "m", cost: { input: 1 } }] } },
    });
    const joined = problems.join("\n");
    for (const k of ["output", "cacheRead", "cacheWrite"]) expect(joined).toContain(k);
  });

  test("a wholly absent cost block is rejected (zero rates report $0.0000)", () => {
    const { problems, table: t } = registry({
      providers: { p: { models: [{ id: "m" }] } },
    });
    expect(problems.join("\n")).toContain("no cost block");
    expect(t.entries.size).toBe(0);
  });

  test("a complete cost block is accepted", () => {
    const { problems, table: t } = registry({
      providers: {
        p: { models: [{ id: "m", cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } }] },
      },
    });
    expect(problems).toEqual([]);
    expect(t.entries.get("p/m")).toEqual({ input: 1, output: 2, cacheRead: 0, cacheWrite: 0 });
  });

  test("a `models` key of the wrong shape is a problem, not a silent skip", () => {
    // Skipping it would disable AC3 for every entry under it — a fail-OPEN on
    // the control that keeps a zero-rate roster from reporting $0.0000.
    const { problems } = registry({ providers: { openrouter: { models: { a: {} } } } });
    expect(problems.join("\n")).toContain("must be a list");
  });

  test("a provider block with NO models key is legitimate and silent", () => {
    // These exist purely to override a base URL or credential.
    const { problems, table: t } = registry({
      providers: { openrouter: { baseUrl: "https://example.invalid/v1" } },
    });
    expect(problems).toEqual([]);
    expect(t.entries.size).toBe(0);
  });

  test("invalid JSON is a problem, not a crash", () => {
    const dir = mkdtempSync(join(tmpdir(), "models-json-bad-"));
    const p = join(dir, "models.json");
    writeFileSync(p, "{ not json");
    const { problems, table: t } = readCustomRegistry(p);
    expect(problems.join("\n")).toContain("invalid JSON");
    expect(t.entries.size).toBe(0);
  });

  test("INV-1 — the registry reader never carries an apiKey out of models.json", async () => {
    const SENTINEL = "sk-sentinel-df15-must-never-appear";
    const dir = mkdtempSync(join(tmpdir(), "models-json-sentinel-"));
    const p = join(dir, "models.json");
    writeFileSync(
      p,
      JSON.stringify({
        providers: {
          openrouter: {
            apiKey: SENTINEL,
            baseUrl: "https://openrouter.ai/api/v1",
            models: [
              {
                id: "anthropic/claude-haiku-4.5",
                apiKey: SENTINEL,
                cost: { input: 1, output: 5, cacheRead: 0, cacheWrite: 0 },
              },
            ],
          },
        },
      }),
    );
    const { table: t, problems } = readCustomRegistry(p);
    expect(JSON.stringify([...t.entries])).not.toContain(SENTINEL);
    expect(problems.join("")).not.toContain(SENTINEL);

    // ...and it reaches no emitter: not the report object, not a stdout byte.
    // (`probeCatalog` is fully stubbed in this test, so there is no real spawn
    // path here to assert an argv against — asserting on a stub's own
    // hard-coded return value would be tautological, not coverage.)
    const stdout: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => {
      stdout.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    let r: Awaited<ReturnType<typeof validateRoster>>;
    try {
      r = await validateRoster(parseRoster(ROSTER), {
        probeCatalog: catalog(CAT),
        probeProvider: provider(LIVE),
        rateSources: { bundled: SOURCES.bundled, custom: t },
        registryProblems: problems,
      });
      process.stdout.write(`${formatReport(r).join("\n")}\n`);
    } finally {
      process.stdout.write = write;
    }
    expect(JSON.stringify(r)).not.toContain(SENTINEL);
    expect(stdout.join("")).not.toContain(SENTINEL);
    expect(r.exitCode).toBe(0);
  });
});

// --- AC5: empty-state boundary ----------------------------------------------

describe("AC5 — a missing ~/.pi/agent/models.json is an empty registry, not an error", () => {
  test("missing file → no problems, empty table", () => {
    const dir = mkdtempSync(join(tmpdir(), "models-json-none-"));
    const { table: t, problems } = readCustomRegistry(join(dir, "models.json"));
    expect(problems).toEqual([]);
    expect(t.entries.size).toBe(0);
  });

  test("a bundled-catalog-only roster exits 0 with source: bundled on every row", async () => {
    const dir = mkdtempSync(join(tmpdir(), "models-json-none2-"));
    const { table: custom, problems } = readCustomRegistry(join(dir, "models.json"));
    const r = await validateRoster(parseRoster(ROSTER), {
      probeCatalog: catalog(CAT),
      probeProvider: provider(LIVE),
      rateSources: { bundled: SOURCES.bundled, custom },
      registryProblems: problems,
    });
    expect(r.exitCode).toBe(0);
    expect(r.roles.every((x) => x.source === "bundled")).toBe(true);
  });
});

// --- AC6: rates -------------------------------------------------------------

describe("AC6 — unit conversion happens exactly once, at load", () => {
  test("hand-computed µ$/MTok, not the raw field", () => {
    // $2.00 per million tokens === 2_000_000 µ$ per million tokens.
    expect(toMicrosPerMTok(2, "usd-per-mtok")).toBe(2_000_000);
    expect(toMicrosPerMTok(0.8, "usd-per-mtok")).toBe(800_000);
  });

  test("a per-token figure resolves to the SAME µ$/MTok as its per-million twin", () => {
    // $0.0000001/token === $0.10/million tokens.
    expect(toMicrosPerMTok(1e-7, "usd-per-token")).toBe(toMicrosPerMTok(0.1, "usd-per-mtok"));
  });

  test("round-to-zero negative control: $0.10/MTok survives integer rounding", () => {
    const inputPerMTok = toMicrosPerMTok(0.1, "usd-per-mtok");
    expect(inputPerMTok).toBe(100_000);
    // The rate survives the round trip through resolveRate, not just the helper,
    // and a consumer divides ONLY at its own projection site.
    const resolved = resolveRate("p/m", {
      bundled: table({ "p/m": { input: 0.1, output: 0.1 } }),
      custom: table({}),
    });
    expect(resolved.inputPerMTok).toBe(100_000);
    expect((250_000 * resolved.inputPerMTok) / 1_000_000).toBe(25_000);
  });

  test("a rate whose unit or value cannot be determined is rejected, not guessed", () => {
    expect(() => toMicrosPerMTok(undefined, "usd-per-mtok")).toThrow(RateError);
    expect(() => toMicrosPerMTok("1", "usd-per-mtok")).toThrow(RateError);
    expect(() => toMicrosPerMTok(Number.NaN, "usd-per-mtok")).toThrow(RateError);
    expect(() => toMicrosPerMTok(-1, "usd-per-mtok")).toThrow(RateError);
    expect(() => toMicrosPerMTok(1, "per-request" as never)).toThrow(RateError);
  });

  test("a 10^6 unit error in EITHER direction is caught by the plausibility band", () => {
    // Per-token data read as per-million. The dangerous cases are the ones that
    // do NOT round to zero: a $3/MTok model stated per token is 0.000003, which
    // survives as 3 µ$/MTok — 10^6 too low, and every downstream cap disarmed.
    // A floor that only catches the round-to-exactly-zero sliver misses this.
    expect(() => toMicrosPerMTok(3e-6, "usd-per-mtok")).toThrow(/floor/);
    expect(() => toMicrosPerMTok(1e-5, "usd-per-mtok")).toThrow(/floor/);
    expect(() => toMicrosPerMTok(1e-7, "usd-per-mtok")).toThrow(/floor/);
    // Per-million data read as per-token: absurdly large. Rejected.
    expect(() => toMicrosPerMTok(3, "usd-per-token")).toThrow(/plausible/);
    // A genuinely free model is still 0, in both units.
    expect(toMicrosPerMTok(0, "usd-per-mtok")).toBe(0);
    expect(toMicrosPerMTok(0, "usd-per-token")).toBe(0);
  });

  test("the floor leaves headroom under the cheapest REAL catalog rate", () => {
    // pi's bundled catalog bottoms out at $0.001/MTok (a cache-read rate). The
    // floor must sit below it, or the band rejects live data.
    expect(toMicrosPerMTok(0.001, "usd-per-mtok")).toBe(1_000);
    expect(toMicrosPerMTok(0.0001, "usd-per-mtok")).toBe(100);
  });
});

describe("AC6 — resolveRate", () => {
  test("returns the four named rates as integers", () => {
    const rate = resolveRate("openrouter/anthropic/claude-haiku-4.5", SOURCES);
    expect(rate).toEqual({
      inputPerMTok: 1_000_000,
      outputPerMTok: 5_000_000,
      cacheReadPerMTok: 0,
      cacheWritePerMTok: 0,
      source: "bundled",
      warnings: [],
    });
    expect(Number.isInteger(rate.inputPerMTok)).toBe(true);
  });

  test("models.json WINS wholesale when both sources price the slug — never a blend", () => {
    const slug = "openrouter/anthropic/claude-haiku-4.5";
    const sources: RateSources = {
      bundled: table({ [slug]: { input: 1, output: 5, cacheRead: 0.5, cacheWrite: 2 } }),
      custom: table({ [slug]: { input: 3, output: 9, cacheRead: 0.25, cacheWrite: 7 } }),
    };
    const rate = resolveRate(slug, sources);
    expect(rate.source).toBe("models.json");
    expect(rate.inputPerMTok).toBe(3_000_000);
    expect(rate.outputPerMTok).toBe(9_000_000);
    // A per-field merge would have taken the bundled cache rates. It must not:
    // every one of the four comes from models.json, never a blend.
    expect(rate.cacheReadPerMTok).toBe(250_000);
    expect(rate.cacheWritePerMTok).toBe(7_000_000);
  });

  test("a slug priced by NEITHER source is rejected naming the slug and both sources", () => {
    try {
      resolveRate("openrouter/unpriced", SOURCES);
      throw new Error("expected RateError");
    } catch (e) {
      expect(e).toBeInstanceOf(RateError);
      const msg = (e as Error).message;
      expect(msg).toContain("openrouter/unpriced");
      expect(msg).toContain("bundled catalog");
      expect(msg).toContain("models.json");
    }
  });

  test("a COMPLETE but all-zero models.json block may not zero a priced model", () => {
    // The key-presence check alone passes this — and models.json winning
    // wholesale would then report $0.0000 on a spending run, at exit 0.
    const slug = "openrouter/m";
    expect(() =>
      resolveRate(slug, {
        bundled: table({ [slug]: { input: 3, output: 15 } }),
        custom: table({ [slug]: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }),
      }),
    ).toThrow(/zero/);
  });

  test("an all-zero models.json block is rejected even with NO bundled counterpart", () => {
    // The likeliest shape of all — a slug registered only in models.json is how
    // this host's own custom model was added. Requiring a bundled entry to
    // contradict would exempt exactly that case.
    const slug = "fifer-ai/fifer";
    expect(() =>
      resolveRate(slug, {
        bundled: table({}),
        custom: table({ [slug]: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }),
      }),
    ).toThrow(/zero/);
  });

  test("input or output zeroed against a priced bundled entry is REJECTED", () => {
    const slug = "openrouter/m";
    try {
      resolveRate(slug, {
        bundled: table({ [slug]: { input: 3, output: 15 } }),
        custom: table({ [slug]: { input: 0, output: 15, cacheRead: 1, cacheWrite: 1 } }),
      });
      throw new Error("expected RateError");
    } catch (e) {
      expect(e).toBeInstanceOf(RateError);
      expect((e as Error).message).toContain("input");
    }
  });

  test("cache rates zeroed against a priced bundled entry WARN rather than reject", () => {
    // AC3 requires all four keys, so an operator overriding input/output on a
    // provider that does not bill for cache has no way to say so except
    // `cacheRead: 0` (pi's own schema rejects a null). A hard gate here would
    // make a legitimate config inexpressible, with no escape hatch.
    const slug = "openrouter/m";
    const rate = resolveRate(slug, {
      bundled: table({ [slug]: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 4 } }),
      custom: table({ [slug]: { input: 5, output: 20, cacheRead: 0, cacheWrite: 0 } }),
    });
    expect(rate.cacheReadPerMTok).toBe(0);
    expect(rate.warnings.join("\n")).toContain("cacheRead");
    expect(rate.warnings.join("\n")).toContain("cacheWrite");
  });

  test("a bundled-catalog zero is the VENDOR's published price and still resolves", () => {
    // The asymmetry is the point: an operator-authored zero is a likely
    // mistake, a vendor-published one (a genuinely free model) is not.
    const slug = "openrouter/free-model:free";
    const rate = resolveRate(slug, {
      bundled: table({ [slug]: { input: 0, output: 0 } }),
      custom: table({}),
    });
    expect(rate.inputPerMTok).toBe(0);
    expect(rate.source).toBe("bundled");
  });

  test("a usd-per-token table resolves through resolveRate, not just the helper", () => {
    const slug = "p/m";
    const rate = resolveRate(slug, {
      bundled: table({ [slug]: { input: 1e-7, output: 4e-7 } }, "usd-per-token"),
      custom: table({}),
    });
    expect(rate.inputPerMTok).toBe(100_000);
    expect(rate.outputPerMTok).toBe(400_000);
  });

  test("a bundled entry missing input or output is rejected — rates never default", () => {
    const sources: RateSources = {
      bundled: table({ "p/m": { output: 5, cacheRead: 1 } }),
      custom: table({}),
    };
    expect(() => resolveRate("p/m", sources)).toThrow(RateError);
  });

  test("negative control — three roles: bundled, models.json, neither", async () => {
    const src = `
defaults:
  provider: openrouter
  writes: []
roles:
  - name: cheap
    model: bundled-model
  - name: custom
    model: custom-model
  - name: orphan
    model: unpriced-model
`;
    const sources: RateSources = {
      bundled: table({ "openrouter/bundled-model": { input: 0.1, output: 0.4 } }),
      custom: table({
        "openrouter/custom-model": { input: 7, output: 21, cacheRead: 1, cacheWrite: 2 },
      }),
    };
    const r = await validateRoster(parseRoster(src), {
      probeCatalog: catalog([
        "openrouter/bundled-model",
        "openrouter/custom-model",
        "openrouter/unpriced-model",
      ]),
      probeProvider: provider(["bundled-model", "custom-model", "unpriced-model"]),
      rateSources: sources,
    });

    expect(r.roles[0]!.source).toBe("bundled");
    expect(r.roles[0]!.rate!.inputPerMTok).toBe(100_000);
    expect(r.roles[0]!.rate!.outputPerMTok).toBe(400_000);

    expect(r.roles[1]!.source).toBe("models.json");
    expect(r.roles[1]!.rate!.inputPerMTok).toBe(7_000_000);
    expect(r.roles[1]!.rate!.outputPerMTok).toBe(21_000_000);

    expect(r.roles[2]!.rate).toBeNull();
    expect(r.roles[2]!.source).toBeNull();
    const msg = r.roles[2]!.problems.join("\n");
    expect(msg).toContain("openrouter/unpriced-model");
    expect(msg).toContain("bundled catalog");
    expect(msg).toContain("models.json");
    // An implementation defaulting an unpriced slug to zero would exit 0 here.
    expect(r.exitCode).toBe(1);
  });
});

// --- observability ----------------------------------------------------------

describe("observability contract", () => {
  test("one record per role, requestId propagated, timings present", async () => {
    const r = await validateRoster(parseRoster(ROSTER), {
      probeCatalog: catalog(CAT),
      probeProvider: provider(LIVE),
      rateSources: SOURCES,
      requestId: "req-df15",
    });
    expect(r.requestId).toBe("req-df15");
    const rec = r.roles[0]!;
    expect(rec.requestId).toBe("req-df15");
    expect(rec.role).toBe("planner");
    expect(rec.slug).toBe("openrouter/anthropic/claude-haiku-4.5");
    expect(rec.provider).toBe("openrouter");
    expect(rec.source).toBe("bundled");
    expect(r.catalogProbeMs).toBe(3);
    expect(r.providerProbeMs).toBe(4);
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("roster warnings ride along on the report", async () => {
    const src = `
roles:
  - name: planner
    provider: openrouter
    model: anthropic/claude-haiku-4.5
    writes: []
    tools: ["read"]
    harness_engineering: ["ext/a.ts"]
`;
    const r = await validateRoster(parseRoster(src), {
      probeCatalog: catalog(CAT),
      probeProvider: provider(LIVE),
      rateSources: SOURCES,
    });
    expect(r.warnings.join("\n")).toMatch(/extension/i);
    expect(r.roles[0]!.warnings.length).toBe(1);
  });
});

// --- bundled catalog reader -------------------------------------------------

describe("loadBundledCatalog", () => {
  test("keys entries as `${providerFileBasename}/${modelId}`", () => {
    const dir = mkdtempSync(join(tmpdir(), "catalog-"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "openrouter.json"),
      JSON.stringify({
        "openai-completions": {
          "anthropic/claude-haiku-4.5": { cost: { input: 1, output: 5, cacheRead: 0.1 } },
        },
      }),
    );
    writeFileSync(join(dir, "broken.json"), "{ not json");
    writeFileSync(join(dir, "README.md"), "ignored");
    const t = loadBundledCatalog(dir);
    expect(t.unit).toBe("usd-per-mtok");
    expect(t.entries.get("openrouter/anthropic/claude-haiku-4.5")).toEqual({
      input: 1,
      output: 5,
      cacheRead: 0.1,
    });
    // One unreadable provider file must not blank the whole table.
    expect(t.entries.size).toBe(1);
  });

  test("an unlocatable catalog is a control failure, not an empty table", () => {
    expect(() => loadBundledCatalog(join(tmpdir(), "definitely-not-here-df15"))).toThrow();
  });

  test("resolveRate's DEFAULT source path — the one DF3.6/DF3.3 call — works", () => {
    // Every other rate test injects explicit sources, so `loadRateSources` and
    // the memo behind `resolveRate(slug)` would otherwise never run.
    const dir = mkdtempSync(join(tmpdir(), "default-sources-"));
    writeFileSync(
      join(dir, "openrouter.json"),
      JSON.stringify({ api: { "some/model": { cost: { input: 2, output: 8 } } } }),
    );
    const registry = join(dir, "models.json");
    writeFileSync(
      registry,
      JSON.stringify({
        providers: {
          openrouter: {
            models: [
              { id: "custom/model", cost: { input: 1, output: 3, cacheRead: 0, cacheWrite: 0 } },
            ],
          },
        },
      }),
    );
    const prevDir = process.env.QDS_PI_CATALOG_DIR;
    const prevReg = process.env.QDS_PI_MODELS_JSON;
    process.env.QDS_PI_CATALOG_DIR = dir;
    process.env.QDS_PI_MODELS_JSON = registry;
    try {
      resetRateSources();
      expect(resolveRate("openrouter/some/model").inputPerMTok).toBe(2_000_000);
      expect(resolveRate("openrouter/custom/model").source).toBe("models.json");

      // The memo is process-lifetime: an edit is invisible until it is reset.
      writeFileSync(registry, JSON.stringify({ providers: {} }));
      expect(resolveRate("openrouter/custom/model").source).toBe("models.json");
      resetRateSources();
      expect(() => resolveRate("openrouter/custom/model")).toThrow(RateError);

      // An unusable registry throws rather than silently dropping its entries.
      writeFileSync(registry, "{ not json");
      resetRateSources();
      expect(() => resolveRate("openrouter/some/model")).toThrow(/unusable/);
    } finally {
      restoreEnv("QDS_PI_CATALOG_DIR", prevDir);
      restoreEnv("QDS_PI_MODELS_JSON", prevReg);
      resetRateSources();
    }
  });

  test("the nesting assumption holds against pi's REAL installed catalog", () => {
    // Everything above uses a fixture this implementation authored. If the real
    // shape differs, the table is empty, every priced role is rejected for "no
    // rate", and those fixture tests still pass — so assert against the host.
    const dir = findBundledCatalogDir();
    if (dir === null) {
      console.warn("loadBundledCatalog: pi's bundled catalog not found on this host — skipped");
      return;
    }
    const t = loadBundledCatalog(dir);
    expect(t.entries.size).toBeGreaterThan(100);
    const priced = [...t.entries].filter(
      ([slug, c]) => slug.startsWith("openrouter/") && (c.input ?? 0) > 0,
    );
    expect(priced.length).toBeGreaterThan(0);
    // And a real slug must survive the whole conversion, not just the read.
    const [slug] = priced[0]!;
    expect(resolveRate(slug, { bundled: t, custom: table({}) }).inputPerMTok).toBeGreaterThan(0);
  });
});
