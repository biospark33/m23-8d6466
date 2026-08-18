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

  test("model is non-empty string", () => {
    expect(fixture.model).toBeString();
    expect(fixture.model.length).toBeGreaterThan(0);
  });

  test("provider is openrouter", () => {
    expect(fixture.provider).toBe("openrouter");
  });

  test("wall_clock_cap_ms is 900000", () => {
    expect(fixture.wall_clock_cap_ms).toBe(900000);
  });

  test("prompt is non-terminating", () => {
    expect(fixture.prompt).toBeString();
    // Must contain "never stop" (case-insensitive)
    expect(fixture.prompt.toLowerCase()).toMatch(/never stop/i);
    // Must NOT contain termination conditions
    expect(fixture.prompt).not.toMatch(/stop after|when you reach|^stop\.$|terminate after/im);
  });
});
