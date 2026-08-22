/**
 * Brief schema tests (Story DF3.1, Agent A): INV-2 closed validation,
 * requestId loose (C3), and manifest stamp round-trip.
 *
 * TDD: tests written first, then implementation.
 *
 * Every rejection names the FIELD and the ISSUE CODE it failed on: a bare
 * `.toThrow()` is satisfied by a schema that rejects the fixture for an
 * unrelated newly-required field, which is exactly the drift these cases exist
 * to catch.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { BriefSchema, extractZodErrorField, type Brief } from "../../src/fleet/brief-schema.ts";
import {
  loadManifest,
  ManifestError,
  PipelineManifestSchema,
  stampManifestLimit,
  serializeManifest,
} from "../../src/phase-engine/manifest.ts";
import { ZodError, type ZodIssueCode } from "zod";

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

/**
 * Every key the schema requires. The fixture supplies exactly these (asserted
 * below), so INV-2's closed validation is pinned for all of them rather than for
 * `repoSlug` alone: every OTHER rejection case here starts from a complete
 * fixture and corrupts one value, which cannot fail when a field stops being
 * required. Make `commitSha` `.optional()` and the 40-hex cases still reject bad
 * values and the valid-parse case still passes — while a brief carrying no
 * commitSha at all is admitted and the dispatcher provisions against an
 * unspecified commit, or reads a `manifestPath` of `undefined`.
 */
const REQUIRED_KEYS = ["repoSlug", "issueId", "commitSha", "manifestPath", "repoUrl"] as const;

/**
 * Assert a brief is refused for the REASON claimed, not merely refused.
 *
 * `extractZodErrorField` is the CLI's own field extractor (AC1 "exits 2 naming
 * the offending field"), so asserting through it pins the operator-visible
 * name, and the issue code pins WHY — a schema that starts rejecting this
 * fixture for a different field or a different reason fails here instead of
 * passing a bare `.toThrow()`.
 */
function expectRejected(
  brief: Record<string, unknown>,
  expected: { field: string; code: keyof typeof ZodIssueCode | string; message?: RegExp },
): void {
  const result = BriefSchema.safeParse(brief);
  expect(result.success).toBe(false);
  const error = (result as { error: ZodError }).error;
  expect(extractZodErrorField(error)).toBe(expected.field);
  const issue = error.issues[0];
  expect(issue).toBeDefined();
  expect(issue?.code).toBe(expected.code as never);
  if (expected.message !== undefined) expect(issue?.message).toMatch(expected.message);
}

describe("brief-schema.ts (DF3.1 AC1, AC2, INV-2, C3)", () => {
  test("valid minimal brief parses", () => {
    const brief = validBrief();
    const result = BriefSchema.parse(brief);
    expect(result).toEqual(brief as Brief);
  });

  test("unknown top-level key rejected (exit-path: parse throws with the key named)", () => {
    const brief = { ...validBrief(), unknownField: "should-reject" };
    expectRejected(brief, { field: "unknownField", code: "unrecognized_keys", message: /unknownField/ });
    expect(() => BriefSchema.parse(brief)).toThrow();
  });

  test("ZodError helper extracts offending field name", () => {
    const brief = { ...validBrief(), unknownField: "x" };
    // The sentinel is hoisted OUT of the try. Thrown inside it, the same catch
    // caught it and fed a plain Error to extractZodErrorField — so a schema that
    // stopped rejecting unknown keys failed here for an accidental reason, and
    // would pass outright the day the helper grows a fallback.
    let thrown: unknown;
    try {
      BriefSchema.parse(brief);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ZodError);
    expect(extractZodErrorField(thrown as ZodError)).toBe("unknownField");
  });

  test("the fixture supplies exactly the required keys and nothing optional", () => {
    // Binds REQUIRED_KEYS to the fixture: a newly required field with no fixture
    // value fails `valid minimal brief parses`, and a newly OPTIONAL field left
    // in the fixture fails here instead of silently escaping the loop below.
    expect(Object.keys(validBrief()).sort()).toEqual([...REQUIRED_KEYS].sort());
  });

  for (const key of REQUIRED_KEYS) {
    test(`missing ${key} rejected (the KEY is absent, not set to undefined)`, () => {
      // `{...brief, key: undefined}` is a PRESENT key: it exercises a different
      // zod path from the brief an operator actually sends, which simply omits
      // the field. Both must be refused, so both are asserted.
      const absent = validBrief();
      expect(absent[key]).toBeDefined(); // it was there; delete removes it
      delete absent[key];
      expect(Object.hasOwn(absent, key)).toBe(false);
      expectRejected(absent, { field: key, code: "invalid_type", message: /Required/ });
      expectRejected(validBrief({ [key]: undefined }), {
        field: key,
        code: "invalid_type",
        message: /Required/,
      });
    });
  }

  test("commitSha not-40-hex rejected: 39 chars", () => {
    expectRejected(validBrief({ commitSha: "a".repeat(39) }), { field: "commitSha", code: "invalid_string" });
  });

  test("commitSha not-40-hex rejected: 41 chars", () => {
    expectRejected(validBrief({ commitSha: "a".repeat(41) }), { field: "commitSha", code: "invalid_string" });
  });

  test("commitSha not-40-hex rejected: uppercase", () => {
    expectRejected(validBrief({ commitSha: "A".repeat(40) }), { field: "commitSha", code: "invalid_string" });
  });

  test("commitSha not-40-hex rejected: non-hex", () => {
    expectRejected(validBrief({ commitSha: "g".repeat(40) }), { field: "commitSha", code: "invalid_string" });
  });

  test("issueId 0 rejected", () => {
    expectRejected(validBrief({ issueId: 0 }), { field: "issueId", code: "too_small", message: /greater than 0/ });
  });

  test("issueId -1 rejected", () => {
    expectRejected(validBrief({ issueId: -1 }), { field: "issueId", code: "too_small", message: /greater than 0/ });
  });

  test("issueId non-int rejected", () => {
    expectRejected(validBrief({ issueId: "not-an-int" }), {
      field: "issueId",
      code: "invalid_type",
      message: /Expected number/,
    });
    expectRejected(validBrief({ issueId: 1.5 }), { field: "issueId", code: "invalid_type", message: /integer/ });
  });

  test("issueId 2^31 rejected (max is 2^31-1)", () => {
    expectRejected(validBrief({ issueId: 2 ** 31 }), {
      field: "issueId",
      code: "too_big",
      message: /2147483647/,
    });
  });

  test("issueId 2^31-1 ACCEPTED (the bound is the max, not a rejection)", () => {
    // The rejecting side alone lets the max be tightened to anything at all —
    // 200 would reject every real GitHub issue number and still pass.
    const result = BriefSchema.parse(validBrief({ issueId: 2 ** 31 - 1 }));
    expect(result.issueId).toBe(2 ** 31 - 1);
  });

  test("issueUrl invalid rejected", () => {
    expectRejected(validBrief({ issueUrl: "not-a-url" }), {
      field: "issueUrl",
      code: "invalid_string",
      message: /url/i,
    });
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

  test("requestId LOOSE still means a STRING — a number or an object is refused", () => {
    // Every other requestId case above asserts acceptance, which `z.any()`
    // satisfies too. C3 relaxes the FORMAT, not the type: the value rides the
    // brief into the run record, the ledger keys and the log correlation, where
    // a `.startsWith`/`join()` on a number or an object throws at dispatch time
    // — past the trust boundary INV-2 puts here.
    for (const bad of [123, { evil: true }, ["a"], true]) {
      expectRejected(validBrief({ requestId: bad }), {
        field: "requestId",
        code: "invalid_type",
        message: /Expected string/,
      });
    }
  });

  test("manifestPath empty string rejected", () => {
    expectRejected(validBrief({ manifestPath: "" }), {
      field: "manifestPath",
      code: "too_small",
      message: /at least 1 character/,
    });
  });

  test("manifestPath parent segment rejected (it is a real host path the dispatcher reads)", () => {
    for (const bad of ["../../../../etc/shadow", "sub/../../escape.json", ".."]) {
      expectRejected(validBrief({ manifestPath: bad }), {
        field: "manifestPath",
        code: "custom",
        message: /may not be '\.\.'/,
      });
    }
  });

  test("manifestPath '.' segments stay legal — './pipeline.json' is an ordinary path", () => {
    // Unlike repoSlug, where '.' is an entire owner/repo name and never valid,
    // a '.' path segment resolves nowhere new. Over-rejecting here would refuse
    // briefs that are correct.
    for (const ok of ["./pipeline.json", "cfg/./pipeline.json", "/abs/path/pipeline.json"]) {
      expect(BriefSchema.parse(validBrief({ manifestPath: ok })).manifestPath).toBe(ok);
    }
  });

  test("repoUrl non-url rejected", () => {
    expectRejected(validBrief({ repoUrl: "not-a-url" }), {
      field: "repoUrl",
      code: "invalid_string",
      message: /url/i,
    });
  });

  test("repoUrl http:// rejected (the scheme is allow-listed to https)", () => {
    expectRejected(validBrief({ repoUrl: "http://github.com/owner/repo" }), {
      field: "repoUrl",
      code: "invalid_string",
      message: /https:\/\//,
    });
  });

  test("repoSlug invalid pattern rejected (no slash)", () => {
    expectRejected(validBrief({ repoSlug: "justowner" }), { field: "repoSlug", code: "invalid_string" });
  });

  test("repoSlug dot segment rejected (it reaches join() on the ledger key)", () => {
    expectRejected(validBrief({ repoSlug: "../repo" }), {
      field: "repoSlug",
      code: "custom",
      message: /may not be '\.' or '\.\.'/,
    });
    expectRejected(validBrief({ repoSlug: "./repo" }), {
      field: "repoSlug",
      code: "custom",
      message: /may not be '\.' or '\.\.'/,
    });
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
  /** The exact object written to disk — the round-trip's expected value. */
  let manifestObj: Record<string, unknown>;

  beforeEach(() => {
    manifestDir = fs.mkdtempSync(path.join(tmpRoot, "manifest-"));
    manifestObj = {
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

  // Each case mkdtemps its own fixture dir; without this they accumulate under
  // tmpRoot for the whole run.
  afterEach(() => fs.rmSync(manifestDir, { recursive: true, force: true }));

  test("stampManifestLimit stamps limitMicroUsd onto a loaded manifest", () => {
    // Use manifestDir as runRoot so INV-1 "beneath root" check passes
    const manifest = loadManifest(manifestPath, 120_000, manifestDir);
    const stamped = stampManifestLimit(manifest, 1_000_000);
    expect(stamped.manifest.limitMicroUsd).toBe(1_000_000);
    expect(Object.isFrozen(stamped.manifest)).toBe(true);
  });

  test("stampManifestLimit does not mutate the caller's manifest", () => {
    // The same loaded manifest is reused across the stamp/serialize call sites;
    // an implementation that stamped in place would leak one run's ceiling into
    // the next caller's copy while still returning a frozen result.
    const manifest = loadManifest(manifestPath, 120_000, manifestDir);
    const before = structuredClone(manifest.manifest) as Record<string, unknown>;
    const stamped = stampManifestLimit(manifest, 777_000);
    expect(stamped.manifest.limitMicroUsd).toBe(777_000);
    expect(manifest.manifest.limitMicroUsd).toBeUndefined();
    expect(manifest.manifest).toEqual(before as never);
  });

  test("stamped value must be int >0 (reject 0)", () => {
    const manifest = loadManifest(manifestPath, 120_000, manifestDir);
    expect(() => stampManifestLimit(manifest, 0)).toThrow(ManifestError);
    expect(() => stampManifestLimit(manifest, 0)).toThrow(/limitMicroUsd must be a positive integer/);
  });

  test("stamped value must be int >0 (reject negative)", () => {
    const manifest = loadManifest(manifestPath, 120_000, manifestDir);
    expect(() => stampManifestLimit(manifest, -100)).toThrow(ManifestError);
    expect(() => stampManifestLimit(manifest, -100)).toThrow(/positive integer/);
  });

  test("stamped value must be int >0 (reject float)", () => {
    const manifest = loadManifest(manifestPath, 120_000, manifestDir);
    expect(() => stampManifestLimit(manifest, 1.5)).toThrow(ManifestError);
    expect(() => stampManifestLimit(manifest, 1.5)).toThrow(/positive integer/);
  });

  // Number.isInteger is true for both of these, so they distinguish the
  // isSafeInteger bound from a plain integer check — the bound dispatch's
  // ceiling guard and the manifest schema now share.
  test("stamped value must be a SAFE integer (reject 1e300)", () => {
    const manifest = loadManifest(manifestPath, 120_000, manifestDir);
    expect(Number.isInteger(1e300)).toBe(true);
    expect(() => stampManifestLimit(manifest, 1e300)).toThrow(ManifestError);
    expect(() => stampManifestLimit(manifest, 1e300)).toThrow(/positive integer/);
  });

  test("stamped value must be a SAFE integer (reject MAX_SAFE_INTEGER + 2)", () => {
    const manifest = loadManifest(manifestPath, 120_000, manifestDir);
    const tooBig = Number.MAX_SAFE_INTEGER + 2;
    expect(Number.isInteger(tooBig)).toBe(true);
    expect(Number.isSafeInteger(tooBig)).toBe(false);
    expect(() => stampManifestLimit(manifest, tooBig)).toThrow(ManifestError);
    expect(() => stampManifestLimit(manifest, tooBig)).toThrow(/positive integer/);
  });

  test("stamped value must be a NUMBER — a numeric string, NaN or null are refused", () => {
    // Every other rejection case passes a number, so a guard written
    // `if (v < 1 || v % 1 !== 0)` would accept "500000" after coercion and stamp
    // a STRING ceiling that the money path then compares with `<` against a
    // number ("500000" < 600000 is false — the cap silently stops binding).
    const manifest = loadManifest(manifestPath, 120_000, manifestDir);
    for (const bad of ["500000", Number.NaN, null, undefined, {}]) {
      expect(() => stampManifestLimit(manifest, bad as unknown as number)).toThrow(ManifestError);
      expect(() => stampManifestLimit(manifest, bad as unknown as number)).toThrow(/positive integer/);
    }
  });

  test("MAX_SAFE_INTEGER itself is accepted — the bound is inclusive", () => {
    const manifest = loadManifest(manifestPath, 120_000, manifestDir);
    const stamped = stampManifestLimit(manifest, Number.MAX_SAFE_INTEGER);
    expect(stamped.manifest.limitMicroUsd).toBe(Number.MAX_SAFE_INTEGER);
  });

  test("serializeManifest outputs 2-space-indented JSON", () => {
    const manifest = loadManifest(manifestPath, 120_000, manifestDir);
    const stamped = stampManifestLimit(manifest, 500_000);
    const text = serializeManifest(stamped);

    // JSON is what loadManifest reads back, so JSON is what must come out —
    // quoted keys, not YAML's bare `limitMicroUsd:`.
    expect(text).toContain('"limitMicroUsd": 500000');
    const reparsed = JSON.parse(text) as Record<string, unknown>;
    expect(reparsed.limitMicroUsd).toBe(500_000);
    expect(reparsed.version).toBe("1.0.0");
    expect(reparsed.pipelineId).toBe("test-pipeline");
    // The indent asserted STRUCTURALLY, over the whole document. Asserting that
    // the second physical line starts with two spaces and a quote held only
    // because `version` is a scalar that happens to come first: any key
    // reordering, a leading comment or a BOM failed a correct implementation,
    // while 4-space, tab or minified output past line 2 passed. Re-emitting the
    // parsed document at indent 2 preserves key order, so this is an exact
    // byte comparison that only the indent (and nesting) can break.
    expect(text).toBe(JSON.stringify(reparsed, null, 2));

    // No YAML re-parse here. `expect(YAML.parse(text)).toEqual(reparsed)` was a
    // tautology — the line above already proves JSON.parse accepts `text`, and
    // YAML 1.2 is a strict superset of JSON, so it cannot fail. The real concern
    // (the dispatcher delivers these bytes under a `.yaml` name, AC9a) is about
    // the DELIVERED artifact, and belongs where delivery happens.
  });

  test("serializeManifest round-trips: loadManifest(serialize(stamped)) validates and carries every phase", () => {
    const manifest = loadManifest(manifestPath, 120_000, manifestDir);
    const stamped = stampManifestLimit(manifest, 500_000);
    const text = serializeManifest(stamped);

    // The real round trip: the delivered bytes go back through the loader the
    // phase engine uses. A serializer that drops `phases` or flattens
    // `command: ["echo","build"]` into a string ships a manifest the engine
    // cannot run — and the previous `typeof reparsed === "object"` check could
    // not fail for either.
    const deliveredPath = path.join(manifestDir, "delivered.json");
    fs.writeFileSync(deliveredPath, text);
    const reloaded = loadManifest(deliveredPath, 120_000, manifestDir);
    expect(reloaded.manifest).toEqual(stamped.manifest);

    // …and the whole document validates against the manifest schema itself,
    // phase-by-phase, not just the two scalars the stamp touched.
    const validated = PipelineManifestSchema.parse(JSON.parse(text));
    expect(validated).toEqual({ ...manifestObj, limitMicroUsd: 500_000 } as never);
    expect(validated.phases).toHaveLength(2);
    expect(validated.phases[1]?.command).toEqual(["echo", "build"]);
    expect(validated.limitMicroUsd).toBe(500_000);
    expect(validated.version).toBe("1.0.0");
  });

  test("stampManifestLimit preserves manifestLoadMs and DROPS resolvedPath", () => {
    const manifest = loadManifest(manifestPath, 120_000, manifestDir);
    const stamped = stampManifestLimit(manifest, 123_456);
    expect(stamped.manifestLoadMs).toBe(manifest.manifestLoadMs);
    // The stamped bytes exist at no path: inheriting the unstamped file's
    // resolvedPath would claim provenance this content no longer has.
    expect(manifest.resolvedPath).toBe(fs.realpathSync(manifestPath));
    expect(stamped.resolvedPath).toBeUndefined();
  });
});
