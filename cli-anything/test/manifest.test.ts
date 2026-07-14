import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { parseManifest, parseManifestFile } from "../src/manifest.ts";

const FIXTURES = join(import.meta.dir, "fixtures");

describe("parseManifest", () => {
  it("parses a well-formed manifest with an env block", () => {
    const m = parseManifest(`
name: env-probe
command: sh
args: ["-c", "echo hi"]
env:
  QDS_PROBE: "x7"
`);
    expect(m.name).toBe("env-probe");
    expect(m.command).toBe("sh");
    expect(m.args).toEqual(["-c", "echo hi"]);
    expect(m.env).toEqual({ QDS_PROBE: "x7" });
  });

  it("parses a bare manifest (no env, no args) and leaves env undefined", () => {
    const m = parseManifest(`
name: bare
command: sh
`);
    expect(m.name).toBe("bare");
    expect(m.env).toBeUndefined();
    expect(m.args).toBeUndefined();
  });

  it("rejects a manifest missing the required name field", () => {
    expect(() =>
      parseManifest(`
command: sh
`),
    ).toThrow(/name/i);
  });

  it("rejects a manifest missing the required command field", () => {
    expect(() =>
      parseManifest(`
name: only-name
`),
    ).toThrow(/command/i);
  });

  it("rejects an env block whose values are not strings", () => {
    expect(() =>
      parseManifest(`
name: bad-env
command: sh
env:
  QDS_PROBE: 7
`),
    ).toThrow();
  });

  it("rejects unknown top-level keys (.strict())", () => {
    expect(() =>
      parseManifest(`
name: extra-key
command: sh
bogus: true
`),
    ).toThrow();
  });

  it("rejects whitespace-only name and command", () => {
    expect(() =>
      parseManifest(`
name: "   "
command: sh
`),
    ).toThrow(/name/i);
    expect(() =>
      parseManifest(`
name: ok
command: "  "
`),
    ).toThrow(/command/i);
  });

  it("rejects syntactically invalid YAML", () => {
    expect(() => parseManifest("name: [unterminated")).toThrow();
  });

  it("parseManifestFile reads and validates a fixture from disk", () => {
    const m = parseManifestFile(join(FIXTURES, "test-env.yaml"));
    expect(m.name).toBe("env-probe");
    expect(m.env).toEqual({ QDS_PROBE: "x7" });
  });

  it("parseManifestFile rejects a fixture missing required fields", () => {
    expect(() =>
      parseManifestFile(join(FIXTURES, "test-malformed.yaml")),
    ).toThrow(/name/i);
  });
});
