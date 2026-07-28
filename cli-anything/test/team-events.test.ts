import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseTeamEventLine, writeArtifactAtomic } from "../src/runner.ts";

describe("parseTeamEventLine — merged", () => {
  it("accepts a genuinely empty result object", () => {
    expect(parseTeamEventLine('{"type":"merged","result":{}}')).toEqual({
      kind: "merged",
      result: {},
    });
  });

  it("rejects a malformed result instead of collapsing it to {}", () => {
    // Each of these used to parse as a "successful" merged event with an empty
    // result, indistinguishable from the case above.
    expect(parseTeamEventLine('{"type":"merged"}')).toBeNull();
    expect(parseTeamEventLine('{"type":"merged","result":null}')).toBeNull();
    expect(parseTeamEventLine('{"type":"merged","result":"oops"}')).toBeNull();
    expect(parseTeamEventLine('{"type":"merged","result":[1,2]}')).toBeNull();
  });
});

describe("writeArtifactAtomic", () => {
  it("rejects traversal and separator names", () => {
    const dir = mkdtempSync(join(tmpdir(), "artifact-guard-"));
    try {
      for (const name of ["../escape", "a/b", "/abs", "a\0b"]) {
        expect(() => writeArtifactAtomic(dir, name, {})).toThrow(
          /unsafe artifact name/,
        );
      }
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves no tmp file behind when the rename fails", () => {
    const dir = mkdtempSync(join(tmpdir(), "artifact-tmp-"));
    try {
      // Non-empty directory at the destination → rename throws after the tmp
      // file has already been written.
      mkdirSync(join(dir, "worker-1.json"));
      writeFileSync(join(dir, "worker-1.json", "occupied"), "x");
      expect(() => writeArtifactAtomic(dir, "worker-1", { ok: true })).toThrow();
      expect(readdirSync(dir)).toEqual(["worker-1.json"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
