/**
 * J3 AC4 — roster tier override (`applyTierOverride`) + rendering
 * (`renderRoster`): purity, non-aliasing, round-trip through `parseRoster`,
 * and the pre-validation contract — an overridden pair is gated by the
 * UNCHANGED `validate.ts` exactly like a hand-written one.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  applyTierOverride,
  parseRoster,
  renderRoster,
  type ResolvedRoster,
} from "../../src/phase-engine/roster/schema.ts";
import {
  type CatalogProbe,
  type ProviderProbe,
  type RateSources,
  type RateTable,
  validateRoster,
} from "../../src/phase-engine/roster/validate.ts";

// --- fixtures ---------------------------------------------------------------

const BASE = `
defaults:
  provider: openrouter
  thinking: medium
  tools: null
  writes: []
  harness_engineering: []

roles:
  - name: lead
    model: anthropic/claude-haiku-4.5
    thinking: high

  - name: fixer
    model: deepseek/deepseek-v3.2
    writes: ["src/", "tests/"]
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

function provider(ids: string[]): (p: string) => Promise<ProviderProbe> {
  return async () => ({ ok: true, ids: new Set(ids), durationMs: 4 });
}

/** The slug of every role in BASE — both gates pass for all of them. */
const LIVE = [
  "openrouter/anthropic/claude-haiku-4.5",
  "openrouter/deepseek/deepseek-v3.2",
];
/** The provider gate matches model ids WITHOUT the provider prefix. */
const MODEL_IDS = ["anthropic/claude-haiku-4.5", "deepseek/deepseek-v3.2"];

function parseFixture(name: string): ResolvedRoster {
  return parseRoster(readFileSync(join(import.meta.dir, "../../config/rosters", name), "utf8"));
}

// --- applyTierOverride ------------------------------------------------------

describe("applyTierOverride", () => {
  test("replaces the pair for the targeted role only, verbatim", () => {
    const r = parseRoster(BASE);
    const out = applyTierOverride(r, {
      fixer: { provider: "zai", model: "moonshot/kimi-k3" },
    });
    const fixer = out.roles.find((x) => x.name === "fixer")!;
    expect(fixer.provider).toBe("zai");
    // VERBATIM model — the embedded `/` is not a split point.
    expect(fixer.model).toBe("moonshot/kimi-k3");
    expect(fixer.slug).toBe("zai/moonshot/kimi-k3");
    // Unrelated fields pass through.
    expect(fixer.writes).toEqual(["src/", "tests/"]);
    expect(fixer.thinking).toBe("medium");
    const lead = out.roles.find((x) => x.name === "lead")!;
    expect(lead.provider).toBe("openrouter");
    expect(lead.model).toBe("anthropic/claude-haiku-4.5");
    expect(lead.slug).toBe("openrouter/anthropic/claude-haiku-4.5");
  });

  test("the input roster is not mutated (identity + values)", () => {
    const r = parseRoster(BASE);
    const before = structuredClone(r);
    applyTierOverride(r, { fixer: { provider: "zai", model: "m" }, noSuchRole: { provider: "x", model: "y" } });
    expect(r).toEqual(before);
  });

  test("the result is a NEW object; role objects and arrays are not aliased", () => {
    const r = parseRoster(BASE);
    const out = applyTierOverride(r, { fixer: { provider: "zai", model: "m" } });
    expect(out).not.toBe(r);
    expect(out.roles).not.toBe(r.roles);
    expect(out.roles[0]).not.toBe(r.roles[0]!);
    expect(out.roles[1]).not.toBe(r.roles[1]!);
    expect(out.roles[0]!.writes).not.toBe(r.roles[0]!.writes);
    expect(out.roles[0]!.harness_engineering).not.toBe(r.roles[0]!.harness_engineering);
    expect(out.roles[0]!.warnings).not.toBe(r.roles[0]!.warnings);
  });

  test("an unknown pair key is not an error and touches nothing", () => {
    const r = parseRoster(BASE);
    const out = applyTierOverride(r, { ghost: { provider: "zai", model: "m" } });
    expect(out.roles).toEqual(parseRoster(BASE).roles);
  });
});

// --- renderRoster round-trip ------------------------------------------------

describe("renderRoster round-trip", () => {
  test("repo roster: parse → render → parse deep-equals the roles", () => {
    const r = parseFixture("roster.yaml");
    const re = parseRoster(renderRoster(r));
    expect(re.roles).toEqual(r.roles);
  });

  test("dispatch fixture roster round-trips", () => {
    const r = parseRoster(
      readFileSync(join(import.meta.dir, "fixtures/dispatch-roster.yaml"), "utf8"),
    );
    const re = parseRoster(renderRoster(r));
    expect(re.roles).toEqual(r.roles);
  });

  test("an overridden roster round-trips; render is deterministic", () => {
    const r = applyTierOverride(parseRoster(BASE), {
      fixer: { provider: "openrouter", model: "anthropic/claude-haiku-4.5" },
    });
    const text = renderRoster(r);
    expect(renderRoster(parseRoster(text))).toBe(text); // byte-stable
    expect(parseRoster(text).roles).toEqual(r.roles);
  });

  test("render→parse re-derives slugs from the OVERRIDE pairs, not the originals", () => {
    // Consumers never read the in-memory object: the setup gate parses the
    // rendered FILE and the in-box engine loadRoster()s the fill file, so the
    // contract that matters is that the re-parse derives its slug
    // (`${provider}/${model}`, schema.ts :345/:388) from the OVERRIDDEN pair.
    const re = parseRoster(
      renderRoster(
        applyTierOverride(parseRoster(BASE), {
          fixer: { provider: "zai", model: "moonshot/kimi-k3" },
        }),
      ),
    );
    expect(re.roles.find((x) => x.name === "fixer")!.slug).toBe("zai/moonshot/kimi-k3");
    expect(re.roles.find((x) => x.name === "lead")!.slug).toBe(
      "openrouter/anthropic/claude-haiku-4.5",
    );
  });
});

// --- pre-validation contract: unchanged validate.ts gates the override -------

describe("override through unchanged validateRoster", () => {
  test("a pair the stub catalog lacks is refused, naming the role", async () => {
    const r = applyTierOverride(parseRoster(BASE), {
      fixer: { provider: "ghost", model: "nope/v1" },
    });
    const report = await validateRoster(parseRoster(renderRoster(r)), {
      probeCatalog: catalog(LIVE),
      probeProvider: provider(MODEL_IDS),
      rateSources: SOURCES,
    });
    expect(report.exitCode).toBe(1);
    const fixer = report.roles.find((x) => x.role === "fixer")!;
    expect(fixer.problems.length).toBeGreaterThan(0);
    // The lead never appeared in the override and still passes.
    expect(report.roles.find((x) => x.role === "lead")!.problems).toEqual([]);
  });

  test("a valid proven pair passes the same stub catalog", async () => {
    const r = applyTierOverride(parseRoster(BASE), {
      fixer: { provider: "openrouter", model: "anthropic/claude-haiku-4.5" },
    });
    const report = await validateRoster(parseRoster(renderRoster(r)), {
      probeCatalog: catalog(LIVE),
      probeProvider: provider(MODEL_IDS),
      rateSources: SOURCES,
    });
    expect(report.exitCode).toBe(0);
    expect(report.roles.find((x) => x.role === "fixer")!.slug).toBe(
      "openrouter/anthropic/claude-haiku-4.5",
    );
  });
});
