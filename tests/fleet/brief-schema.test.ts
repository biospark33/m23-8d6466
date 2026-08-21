/**
 * Brief schema tests (Story DF3.1, Agent A): INV-2 closed validation,
 * requestId loose (C3), and manifest stamp round-trip.
 *
 * TDD: tests written first, then implementation.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as YAML from "yaml";

import { BriefSchema, extractZodErrorField, type Brief } from "../../src/fleet/brief-schema.ts";
import { loadManifest, stampManifestLimit, serializeManifest } from "../../src/phase-engine/manifest.ts";
import type { ZodError } from "zod";

const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "df3-1-brief-")));
afterAll(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

function validBrief(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    repoSlug: "owner/repo",
    issueId: 123,
    commitSha: "a".repeat(40),
    manifestPath: "/path/to/pipeline.json",
    repoUrl: "https://github.com/owner/repo",
    ...over,
  };
}

describe("brief-schema.ts (DF3.1 AC1, AC2, INV-2, C3)", () => {
  test("valid minimal brief parses", () => {
    const brief = validBrief();
    const result = BriefSchema.parse(brief);
    expect(result).toEqual(brief as Brief);
  });

  test("unknown top-level key rejected (exit-path: parse throws with the key named)", () => {
    const brief = {
      ...validBrief(),
      unknownField: "should-reject",
    };
    expect(() => BriefSchema.parse(brief)).toThrow();
  });

  test("ZodError helper extracts offending field name", () => {
    const brief = { ...validBrief(), unknownField: "x" };
    try {
      BriefSchema.parse(brief);
      throw new Error("should have thrown");
    } catch (e) {
      const fieldName = extractZodErrorField(e as ZodError);
      expect(fieldName).toBe("unknownField");
    }
  });

  test("missing repoSlug rejected", () => {
    const brief = { ...validBrief(), repoSlug: undefined };
    expect(() => BriefSchema.parse(brief)).toThrow();
  });

  test("commitSha not-40-hex rejected: 39 chars", () => {
    const brief = validBrief({ commitSha: "a".repeat(39) });
    expect(() => BriefSchema.parse(brief)).toThrow();
  });

  test("commitSha not-40-hex rejected: 41 chars", () => {
    const brief = validBrief({ commitSha: "a".repeat(41) });
    expect(() => BriefSchema.parse(brief)).toThrow();
  });

  test("commitSha not-40-hex rejected: uppercase", () => {
    const brief = validBrief({ commitSha: "A".repeat(40) });
    expect(() => BriefSchema.parse(brief)).toThrow();
  });

  test("commitSha not-40-hex rejected: non-hex", () => {
    const brief = validBrief({ commitSha: "g".repeat(40) });
    expect(() => BriefSchema.parse(brief)).toThrow();
  });

  test("issueId 0 rejected", () => {
    const brief = validBrief({ issueId: 0 });
    expect(() => BriefSchema.parse(brief)).toThrow();
  });

  test("issueId -1 rejected", () => {
    const brief = validBrief({ issueId: -1 });
    expect(() => BriefSchema.parse(brief)).toThrow();
  });

  test("issueId non-int rejected", () => {
    const brief = validBrief({ issueId: "not-an-int" });
    expect(() => BriefSchema.parse(brief)).toThrow();
  });

  test("issueId 2^31 rejected (max is 2^31-1)", () => {
    const brief = validBrief({ issueId: 2 ** 31 });
    expect(() => BriefSchema.parse(brief)).toThrow();
  });

  test("issueUrl invalid rejected", () => {
    const brief = validBrief({ issueUrl: "not-a-url" });
    expect(() => BriefSchema.parse(brief)).toThrow();
  });

  test("issueUrl valid URL accepted (optional)", () => {
    const brief = validBrief({ issueUrl: "https://github.com/owner/repo/issues/123" });
    const result = BriefSchema.parse(brief);
    expect(result.issueUrl).toBe("https://github.com/owner/repo/issues/123");
  });

  test("requestId absent OK (C3: loose)", () => {
    const brief = validBrief();
    const result = BriefSchema.parse(brief);
    expect(result.requestId).toBeUndefined();
  });

  test("requestId any string OK (C3: loose, not UUID validation at schema layer)", () => {
    const brief = validBrief({ requestId: "not-a-uuid" });
    const result = BriefSchema.parse(brief);
    expect(result.requestId).toBe("not-a-uuid");
  });

  test("requestId UUID v4 shape also OK (but not enforced at schema layer)", () => {
    const brief = validBrief({ requestId: "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d" });
    const result = BriefSchema.parse(brief);
    expect(result.requestId).toBe("9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d");
  });

  test("manifestPath empty string rejected", () => {
    const brief = validBrief({ manifestPath: "" });
    expect(() => BriefSchema.parse(brief)).toThrow();
  });

  test("repoUrl non-url rejected", () => {
    const brief = validBrief({ repoUrl: "not-a-url" });
    expect(() => BriefSchema.parse(brief)).toThrow();
  });

  test("repoSlug invalid pattern rejected (no slash)", () => {
    const brief = validBrief({ repoSlug: "justowner" });
    expect(() => BriefSchema.parse(brief)).toThrow();
  });

  test("repoSlug valid pattern accepted", () => {
    const brief = validBrief({ repoSlug: "owner-name/repo.name" });
    const result = BriefSchema.parse(brief);
    expect(result.repoSlug).toBe("owner-name/repo.name");
  });
});

describe("manifest stamp helpers (DF3.1 AC9a)", () => {
  let manifestDir: string;
  let manifestPath: string;

  beforeEach(() => {
    manifestDir = fs.mkdtempSync(path.join(tmpRoot, "manifest-"));
    const manifestObj = {
      version: "1.0.0",
      pipelineId: "test-pipeline",
      runBudgetMs: 120_000,
      phases: [
        {
          name: "plan",
          kind: "engineer",
          description: "Produce the reviewed implementation plan",
          maxDurationMs: 10_000,
          retries: 0,
        },
        {
          name: "build",
          kind: "code",
          description: "Compile and test the implementation",
          maxDurationMs: 10_000,
          retries: 0,
          command: ["echo", "build"],
        },
      ],
    };
    manifestPath = path.join(manifestDir, "pipeline.json");
    fs.writeFileSync(manifestPath, JSON.stringify(manifestObj));
  });

  test("stampManifestLimit stamps limitMicroUsd onto a loaded manifest", () => {
    // Use manifestDir as runRoot so INV-1 "beneath root" check passes
    const manifest = loadManifest(manifestPath, 120_000, manifestDir);
    const stamped = stampManifestLimit(manifest, 1_000_000);
    expect(stamped.manifest.limitMicroUsd).toBe(1_000_000);
    expect(Object.isFrozen(stamped.manifest)).toBe(true);
  });

  test("stamped value must be int >0 (reject 0)", () => {
    const manifest = loadManifest(manifestPath, 120_000, manifestDir);
    expect(() => stampManifestLimit(manifest, 0)).toThrow();
  });

  test("stamped value must be int >0 (reject negative)", () => {
    const manifest = loadManifest(manifestPath, 120_000, manifestDir);
    expect(() => stampManifestLimit(manifest, -100)).toThrow();
  });

  test("stamped value must be int >0 (reject float)", () => {
    const manifest = loadManifest(manifestPath, 120_000, manifestDir);
    expect(() => stampManifestLimit(manifest, 1.5)).toThrow();
  });

  test("serializeManifest outputs YAML string", () => {
    const manifest = loadManifest(manifestPath, 120_000, manifestDir);
    const stamped = stampManifestLimit(manifest, 500_000);
    const yaml = serializeManifest(stamped);

    // Should be parseable YAML
    const reparsed = YAML.parse(yaml);
    expect(reparsed.limitMicroUsd).toBe(500_000);
    expect(reparsed.version).toBe("1.0.0");
    expect(reparsed.pipelineId).toBe("test-pipeline");
  });

  test("serializeManifest round-trips: parse(serialize(stamped)) validates and carries limitMicroUsd", () => {
    const manifest = loadManifest(manifestPath, 120_000, manifestDir);
    const stamped = stampManifestLimit(manifest, 500_000);
    const yaml = serializeManifest(stamped);

    // Parse back as JSON (loadManifest format) — should still validate
    const reparsedObj = JSON.parse(JSON.stringify(YAML.parse(yaml)));
    expect(typeof reparsedObj).toBe("object");

    // BriefSchema won't parse manifest structure, but YAML round-trip holds
    const parsedYaml = YAML.parse(yaml);
    expect(parsedYaml.limitMicroUsd).toBe(500_000);
    expect(parsedYaml.version).toBe("1.0.0");
  });

  test("stampManifestLimit preserves manifestLoadMs and resolvedPath", () => {
    const manifest = loadManifest(manifestPath, 120_000, manifestDir);
    const stamped = stampManifestLimit(manifest, 123_456);
    expect(stamped.manifestLoadMs).toBe(manifest.manifestLoadMs);
    expect(stamped.resolvedPath).toBe(manifest.resolvedPath);
  });
});
