import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { describe, test, expect } from "bun:test";

describe("loopy-workload.yaml fixture", () => {
  const fixturePath = join(import.meta.dir, "loopy-workload.yaml");
  const raw = readFileSync(fixturePath, "utf-8");
  const fixture = parse(raw);

  test("parses as YAML", () => {
    expect(fixture).toBeObject();
    expect(fixture).not.toBeNull();
  });

  test("model is non-empty string, matches the demo roster, and is priced in the shipped catalog", () => {
    expect(fixture.model).toBeString();
    expect(fixture.model.length).toBeGreaterThan(0);
    // Slug consistency across all three fixtures: the workload model must be
    // the roster's runner model AND an entry in the placed models.json —
    // anything else and the demo bills a model the cost table never priced.
    const roster = parse(readFileSync(join(import.meta.dir, "df2-4-demo.roster.yaml"), "utf-8"));
    const catalog = JSON.parse(readFileSync(join(import.meta.dir, "df2-4-models.json"), "utf-8"));
    expect(fixture.model).toBe(roster.roles[0].model);
    expect(catalog.providers.openrouter.models.map((m: { id: string }) => m.id)).toContain(fixture.model);
  });

  test("provider is openrouter", () => {
    expect(fixture.provider).toBe("openrouter");
  });

  test("wall_clock_cap_ms is 900000", () => {
    expect(fixture.wall_clock_cap_ms).toBe(900000);
  });

  test("fixture turns always spend and the prompt carries no termination phrasing (Infra Prereq inputs)", () => {
    // The non-terminating shape is the paid-until-refusal LOOP in
    // cap-hit-demo.ts, not an endless per-turn reply (measured 2026-08-19: a
    // "count forever" turn on a 65K-maxTokens reasoning model never completes
    // inside the 900 s ceiling). The fixture's job: turns that (a) always
    // spend — paddingBytes > 0 so every turn carries cache-busting random
    // input — and (b) carry no termination condition of their own; the only
    // thing that ends the workload is the provider's refusal (or the
    // wall-clock backstop).
    expect(fixture.prompt).toBeString();
    expect(fixture.paddingBytes).toBeNumber();
    expect(fixture.paddingBytes).toBeGreaterThan(0);
    expect(String(fixture.prompt)).not.toMatch(/stop after|when you reach|^stop\.$|terminate after/im);
  });
});
