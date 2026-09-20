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

import {
  BriefSchema,
  extractZodErrorField,
  ROOT_FIELD_LABEL,
  sanitizeLabel,
  type Brief,
} from "../../src/fleet/brief-schema.ts";
import {
  loadManifest,
  ManifestError,
  PipelineManifestSchema,
  stampManifestLimit,
  serializeManifest,
  stripAuthoredLimit,
} from "../../src/phase-engine/manifest.ts";
import {
  CorrelationError,
  MAX_ISSUE_ID,
  resolveRunCorrelation,
} from "../../src/phase-engine/issue-correlation.ts";
import { ZodError, type ZodIssueCode } from "zod";

const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "df3-1-brief-")));
afterAll(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

function validBrief(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    repoSlug: "owner/repo",
    issueId: 123,
    commitSha: "a".repeat(40),
    // RELATIVE: the dispatcher resolves this against the repo root, and an
    // absolute path discards that root outright (round 4, H1).
    manifestPath: "path/to/pipeline.json",
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
  expected: {
    field: string;
    code: keyof typeof ZodIssueCode | string;
    message?: RegExp;
    /**
     * Other fields this value is EXPECTED to implicate, spelled out per case.
     *
     * Only the repoUrl↔repoSlug cross-check produces one: it runs after the
     * field checks and compares the two, so a corrupted `repoSlug` fails its own
     * rule AND stops matching a `repoUrl` that was never touched. That coupling
     * is the refine working, and naming it per case is what keeps the default
     * (no other field) strict everywhere else.
     */
    alsoNames?: readonly string[];
  },
): void {
  const result = BriefSchema.safeParse(brief);
  expect(result.success).toBe(false);
  const error = (result as { error: ZodError }).error;
  expect(extractZodErrorField(error)).toBe(expected.field);
  const issue = error.issues[0];
  expect(issue).toBeDefined();
  expect(issue?.code).toBe(expected.code as never);
  if (expected.message !== undefined) expect(issue?.message).toMatch(expected.message);
  // ONE field, and this one. `issues[0]` is whichever zod happened to emit
  // first, so every case here survived the schema ALSO rejecting a second,
  // unrelated field — the corrupted value would keep passing while a rule that
  // has nothing to do with it did the refusing, and which of the two landed at
  // index 0 is a function of declaration order.
  //
  // A count is the wrong assertion: one value legitimately fails several checks
  // on ITS OWN field (`requestId: "\t"` is both a control character and blank),
  // and that is not drift. The invariant is that no OTHER field is implicated.
  // `unrecognized_keys` carries an empty path by construction, which is exactly
  // the root-shaped case the paths below already collapse to.
  expect(new Set(error.issues.map((i) => i.path.join(".")))).toEqual(
    new Set([issue?.code === "unrecognized_keys" ? "" : expected.field, ...(expected.alsoNames ?? [])]),
  );
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
    // The throw itself must name the key — the exit-2 path formats its payload
    // from the ZodError's own issue text, so a rejection whose MESSAGE dropped
    // the key would exit 2 with a refusal the operator cannot act on.
    expect(() => BriefSchema.parse(brief)).toThrow(/unknownField/);
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

  test("a hostile unknown-key NAME is refused, and the extractor STRIPS the control characters", () => {
    // Every other unknown-key case uses a benign name, so nothing here has ever
    // exercised the fact that the key is ATTACKER-CHOSEN: a brief is
    // attacker-authored JSON, and `NO_CONTROL_CHARS` guards VALUES — no rule
    // anywhere constrained a key NAME. `extractZodErrorField` used to return it
    // with no transformation at all, which put the one threat this schema argues
    // at length — a forged operator-facing log line — on the REJECTION path,
    // reachable by anyone who can hand the CLI a brief.
    //
    // The extractor now sanitizes, so the label is safe in a consumer that does
    // nothing else with it. `dispatch.ts` still escapes what it interpolates
    // (`JSON.stringify(field)` in the message and the remediation, and the
    // issues array too), and that escaping stays: it is what keeps the surviving
    // text readable. The two are belt and braces, not one instead of the other.
    for (const [hostile, expected] of [
      ["\u001b[2Jrm -rf", "[2Jrm -rf"],
      ["a\nFLEET dispatch ok runId=fake", "aFLEET dispatch ok runId=fake"],
    ] as const) {
      expectRejected(validBrief({ [hostile]: "x" }), {
        field: expected,
        code: "unrecognized_keys",
      });
    }
  });

  test("an unknown-key name is length-capped, and an all-control one still names the root", () => {
    // The other half of the same uncapped hole: megabytes of attacker text rode
    // the refusal into the operator stream and into the persisted dispatch log.
    // The cap is the argument MAX_REQUEST_ID already makes for a brief VALUE,
    // applied to the side of the trust boundary that REFUSES.
    const huge = "k".repeat(5000);
    const field = extractZodErrorField(
      (BriefSchema.safeParse(validBrief({ [huge]: "x" })) as { error: ZodError }).error,
    );
    expect(field.length).toBeLessThanOrEqual(129); // the 128 cap plus one truncation marker
    expect(field.startsWith("kkkk")).toBe(true);

    // A name that is ENTIRELY control characters sanitizes to "", and "every
    // return is a non-empty label" has to survive that — it is the invariant,
    // not something zod's output happened to hand back.
    expect(
      extractZodErrorField(
        (BriefSchema.safeParse(validBrief({ "​‮": "x" })) as { error: ZodError }).error,
      ),
    ).toBe(ROOT_FIELD_LABEL);
  });

  test("prototype-pollution key names are refused as unknown keys, not absorbed", () => {
    // `__proto__` reached through `JSON.parse` — which is how a brief actually
    // arrives — is a REAL own enumerable key, unlike the object-literal form
    // `{ __proto__: … }`, which invokes the setter and leaves no own key at all.
    // So a brief can carry one, and `z.strictObject` is the only thing refusing
    // it. Relax this schema to `.passthrough()`/`.catchall()` and all three ride
    // into `parsed.data`, which is spread into the run record and the manifest
    // stamp — and `constructor`/`prototype` shadow properties every downstream
    // `obj.constructor` check reads.
    for (const key of ["__proto__", "constructor", "prototype"]) {
      const brief = JSON.parse(JSON.stringify({ ...validBrief(), [key]: { polluted: true } })) as Record<
        string,
        unknown
      >;
      // The premise of the case: the round trip really did produce an own,
      // enumerable key. Without this the test could pass on a fixture that
      // never carried the key at all.
      expect(Object.hasOwn(brief, key)).toBe(true);
      expect(Object.keys(brief)).toContain(key);
      // The refusal IS the anti-pollution guarantee — pollution can only
      // happen if the key SURVIVES validation into `parsed.data` and is later
      // merged/spread, so strictObject rejecting it here is the whole claim.
      // (A former `expect(({}).polluted).toBeUndefined()` here asserted a
      // property of a fresh object literal nothing under test touched.)
      expectRejected(brief, { field: key, code: "unrecognized_keys" });
    }
  });

  test("a non-object brief is refused and NAMED — the root label, not an empty field", () => {
    // The case the extractor's docblock was written for: a root rejection
    // carries an EMPTY path, and AC1's "exits 2 naming the offending field"
    // becomes `field ` — nothing an operator can act on.
    //
    // `undefined`, a Date and a function are on the list because they are what
    // a real carrier produces, not what a test author thinks of: `undefined` is
    // an unparsed stdin or a missing `--brief`, a Date is what a JSON reviver or
    // an IPC layer hands back for a date-shaped value, and a function is what an
    // in-process caller passes when it forgets to CALL its brief builder. Each
    // takes a different arm of zod's type dispatch on the way to the same label.
    for (const notAnObject of ["not an object", null, 42, ["repoSlug"], undefined, new Date(), () => {}]) {
      const result = BriefSchema.safeParse(notAnObject);
      expect(result.success).toBe(false);
      const error = (result as { error: ZodError }).error;
      expect(error.issues[0]?.code).toBe("invalid_type");
      expect(error.issues[0]?.path).toEqual([]);
      expect(extractZodErrorField(error)).toBe(ROOT_FIELD_LABEL);
    }
  });

  test("a NULL-PROTOTYPE object is parsed as an object, not waved through and not a crash", () => {
    // `Object.create(null)` is the other shape a JSON/IPC layer produces, and it
    // is NOT a root rejection: zod sees an object, so the brief goes through the
    // ordinary field checks — which is the point. A guard written with
    // `brief instanceof Object`, `brief.constructor === Object` or a
    // `hasOwnProperty` call off the prototype throws on this value instead of
    // refusing it, and a throw past the trust boundary is not the exit 2 INV-2
    // promises.
    const bare = Object.create(null) as Record<string, unknown>;
    Object.assign(bare, validBrief());
    expect(Object.getPrototypeOf(bare)).toBeNull();
    expect(BriefSchema.parse(bare)).toEqual(validBrief() as Brief);

    // …and an empty one is refused FIELD BY FIELD, not by type: every required
    // key is named, which is what an operator needs, rather than one root-level
    // "not an object" for a value that is one.
    const empty = BriefSchema.safeParse(Object.create(null));
    expect(empty.success).toBe(false);
    const issues = (empty as { error: ZodError }).error.issues;
    expect(issues.every((i) => i.code === "invalid_type")).toBe(true);
    expect(new Set(issues.map((i) => i.path.join(".")))).toEqual(new Set(REQUIRED_KEYS));
  });

  test("extractZodErrorField never returns an empty label, even for a degenerate ZodError", () => {
    // The two fallbacks no real parse reaches: zod is free to hand back an error
    // with no issues, or an unrecognized_keys issue with no keys, and both then
    // returned "" through a `??`/`||` that only exists to stop that.
    expect(extractZodErrorField(new ZodError([]))).toBe(ROOT_FIELD_LABEL);
    expect(
      extractZodErrorField(
        new ZodError([{ code: "unrecognized_keys", keys: [], path: [], message: "Unrecognized key(s)" }]),
      ),
    ).toBe(ROOT_FIELD_LABEL);
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

  test("explicit null is refused for every field — required AND optional", () => {
    // Absent and `undefined` are both covered above precisely because they take
    // different zod paths. `null` is a THIRD, and it is the one JSON can
    // actually carry: a templating layer that renders an unset value emits
    // `"issueUrl": null`, and `.nullish()` is a one-word loosening of
    // `.optional()` that would let that through — after which `issueUrl.
    // startsWith(…)` and `new URL(issueUrl)` run on `null` past the trust
    // boundary INV-2 puts here, not at exit 2.
    for (const key of [...REQUIRED_KEYS, "issueUrl", "requestId"]) {
      expectRejected(validBrief({ [key]: null }), {
        field: key,
        code: "invalid_type",
        message: /received null/,
      });
    }
  });

  test.each([
    ["repoSlug", 42],
    ["repoSlug", false],
    ["commitSha", true],
    ["commitSha", ["a".repeat(40)]], // an ARRAY is what a "list of shas" guess actually sends
    ["manifestPath", 3.5],
    ["repoUrl", { evil: true }],
  ])("wrong-TYPE %s (%p) refused as invalid_type naming the field", (key, bad) => {
    // absent/undefined/null are pinned per field above; type-rejection itself
    // was exercised only via issueId/requestId, so a z.string() that drifted
    // to z.any() on one of THESE four fields would have shipped green. A
    // templating layer rendering a number or a boolean into a string field is
    // the realistic carrier.
    expectRejected(validBrief({ [key]: bad }), {
      field: key,
      code: "invalid_type",
      message: /Expected string/,
    });
  });

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

  test("issueId NaN, ±Infinity and -0 rejected", () => {
    // Every other issueId case is a finite in-range number, so the three values
    // that break ORDER COMPARISON itself have never been fed to the bound.
    // `NaN` compares false against every bound at once, so a guard written
    // `v < 1 || v > MAX` admits it and `String(NaN)` becomes "NaN" in the
    // `${slug}#${issueId}` ledger key. `Infinity` passes `> 0` and is not an
    // integer. `-0` is the subtle one: falsy, signed, `-0 >= 0` is true, and it
    // `String()`s to "0" — issue zero, which exists nowhere.
    expectRejected(validBrief({ issueId: Number.NaN }), {
      field: "issueId",
      code: "invalid_type",
      message: /received nan/i,
    });
    for (const inf of [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expectRejected(validBrief({ issueId: inf }), {
        field: "issueId",
        code: "invalid_type",
        message: /integer/,
      });
    }
    expectRejected(validBrief({ issueId: -0 }), {
      field: "issueId",
      code: "too_small",
      message: /greater than 0/,
    });
  });

  test("the issueId bound is DF1.8's MAX_ISSUE_ID, and BOTH enforcers agree at it", () => {
    // The schema and `resolveRunCorrelation` refuse against the same bound, and
    // while the schema restated `2 ** 31 - 1` as a literal the two silently
    // stopped agreeing the moment either moved — one refusing at exit 2 and the
    // other throwing a CorrelationError, for the same brief. Imported, not
    // restated, is the same argument `REPO_SLUG_PATTERN` already makes; this
    // case is what makes the import load-bearing rather than cosmetic.
    expect(MAX_ISSUE_ID).toBe(2 ** 31 - 1);

    const atMax = BriefSchema.parse(validBrief({ issueId: MAX_ISSUE_ID }));
    expect(atMax.issueId).toBe(MAX_ISSUE_ID);
    expect(resolveRunCorrelation(atMax).issueId).toBe(MAX_ISSUE_ID);

    expectRejected(validBrief({ issueId: MAX_ISSUE_ID + 1 }), { field: "issueId", code: "too_big" });
    expect(() => resolveRunCorrelation({ ...atMax, issueId: MAX_ISSUE_ID + 1 })).toThrow(CorrelationError);
  });

  test("issueUrl invalid rejected", () => {
    expectRejected(validBrief({ issueUrl: "not-a-url" }), {
      field: "issueUrl",
      code: "invalid_string",
      message: /url/i,
    });
  });

  test("issueUrl scheme is allow-listed to https — http, file and javascript rejected", () => {
    // `not-a-url` above fails on `.url()` alone, so it passes with the scheme
    // check DELETED: `new URL()` accepts every one of these three. The value
    // lands in run-context.json and in log lines an operator clicks.
    for (const bad of [
      "http://github.com/owner/repo/issues/1",
      "file:///etc/passwd",
      "javascript:alert(document.domain)",
    ]) {
      expectRejected(validBrief({ issueUrl: bad }), {
        field: "issueUrl",
        code: "invalid_string",
        message: /must be an https:\/\/ URL/,
      });
    }
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

  test("manifestPath that is only WHITESPACE is rejected — `.min(1)` is not non-blankness", () => {
    // `NO_CONTROL_CHARS` excludes `\p{Zs}`, deliberately (a space is not a
    // control character), so `"   "` passed the length cap, the charset, the
    // parent-segment guard and the relative-path guard — every rule this field
    // has. `.min(1)` refuses `""` and nothing else, while the reason it exists
    // (this value is a real host path) is defeated by any run of spaces:
    // `resolve(repoRoot, "   ")` is `<repoRoot>/   `, which fails at `fs` as an
    // untyped error rather than as the exit 2 the schema exists to produce.
    // `.trim().length` is what the `.min(1)` argument actually implies.
    // Spelled with escapes: NBSP and the ideographic space are `\p{Zs}` like a
    // plain space, and both are what a copy-paste out of a wiki or an issue
    // body actually produces. (A tab is refused one rule earlier, as a control
    // character — that is the sibling case, not this one.)
    for (const blank of ["   ", "\u00a0", "\u3000", "\u2003"]) {
      expectRejected(validBrief({ manifestPath: blank }), {
        field: "manifestPath",
        code: "custom",
        message: /may not be blank/,
      });
    }
  });

  test("a manifestPath with a TRAILING space is accepted — trimming it would name a different file", () => {
    // The boundary the guard above must not cross. A trailing space is legal in
    // a POSIX filename, so `"cfg/pipeline.json "` and `"cfg/pipeline.json"` are
    // two different files: a schema that trimmed the VALUE (rather than testing
    // the trimmed length) would silently redirect the dispatcher to the other
    // one, and a schema that refused it would reject a brief that is correct.
    // Blankness is the property being refused, not whitespace.
    const padded = "cfg/pipeline.json ";
    expect(BriefSchema.parse(validBrief({ manifestPath: padded })).manifestPath).toBe(padded);
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

  test("manifestPath backslash parent segment rejected (the guard is about traversal, not POSIX)", () => {
    // `p.split("/")` never saw these: on a Windows host they walk out of the
    // repo root, and the guard's own docblock claims to refuse traversal.
    for (const bad of ["..\\..\\etc\\hosts", "cfg\\..\\..\\escape.json"]) {
      expectRejected(validBrief({ manifestPath: bad }), {
        field: "manifestPath",
        code: "custom",
        message: /may not be '\.\.'/,
      });
    }
  });

  test("manifestPath ABSOLUTE rejected — no '..' is needed to escape the repo root", () => {
    // `path.resolve(repoRoot, "/etc/shadow")` returns "/etc/shadow": the root is
    // discarded outright. The parent-segment guard alone was never containment,
    // and INV-2 puts the trust boundary here, not on dispatch's second gate.
    for (const bad of ["/etc/shadow", "/abs/path/pipeline.json", "\\\\host\\share\\p.json", "C:\\p.json"]) {
      expectRejected(validBrief({ manifestPath: bad }), {
        field: "manifestPath",
        code: "custom",
        message: /must be relative/,
      });
    }
  });

  test("manifestPath NUL byte rejected as exit-2, not as an untyped fs error", () => {
    // A NUL reaches Node `fs` as ERR_INVALID_ARG_VALUE — past the boundary the
    // schema is supposed to be.
    expectRejected(validBrief({ manifestPath: "cfg/pipe\u0000.json" }), {
      field: "manifestPath",
      code: "invalid_string",
      message: /control characters/,
    });
  });

  test("a LONE SURROGATE is rejected — the one ill-formedness the control categories cannot see", () => {
    // \uD800 unpaired is an unassigned code point, not Cc/Zl/Zp/Cf, so
    // NO_CONTROL_CHARS admits it and Node `fs` answers the path with an
    // untyped ERR_INVALID_ARG_VALUE — the NUL arm's failure mode, one code
    // point over. Each fixture fails on WELL-FORMEDNESS alone (charset,
    // length, traversal and absoluteness all pass), so a guard that grew or
    // shrank the wrong rule cannot satisfy this by accident.
    for (const [field, value] of [
      ["manifestPath", "cfg/pi\uD800pe.json"],
      ["requestId", "req-\uD800"],
      ["repoUrl", "https://github.com/o\uDFFFwner/repo"],
      ["issueUrl", "https://github.com/o\uDFFFwner/repo/issues/1"],
    ] as const) {
      expectRejected(validBrief({ [field]: value }), {
        field,
        code: "custom",
        message: /unpaired surrogates/,
      });
    }
  });

  test("the lone-surrogate rule is load-bearing on the URL fields — `.url()` parses one", () => {
    // WHATWG `URL` accepts a lone surrogate in its input and serializes it
    // percent-encoded, so every URL-side guard downstream sees a CLEAN string:
    // the scheme check passes and the repoSlug cross-check compares against
    // the encoded form. The refusal has to run on the RAW string, exactly like
    // the control-char case above it.
    const url = "https://github.com/o\uD800wner/repo";
    expect(new URL(url).href).not.toContain("\uD800"); // .url() alone would pass it
    expectRejected(validBrief({ repoUrl: url }), {
      field: "repoUrl",
      code: "custom",
      message: /unpaired surrogates/,
    });
  });

  test("a PAIRED surrogate stays legal — the rule rejects ill-formedness, not non-ASCII", () => {
    const p = "cfg/\u{1F4E8}.json";
    expect(BriefSchema.parse(validBrief({ manifestPath: p })).manifestPath).toBe(p);
  });

  test("sanitizeLabel replaces a lone surrogate instead of passing it through", () => {
    // The matcher arm of the same rule: stripping control characters cannot
    // remove ill-formedness, and a label that still carries one surprises any
    // consumer that re-encodes it — an fs path among them. Control characters
    // are still STRIPPED; only surrogates have no printable form to keep.
    expect(sanitizeLabel("box-\uD800name\nline", 64)).toBe("box-�nameline");
  });

  test("manifestPath at the 1024 cap accepted, one over rejected", () => {
    const atCap = `${"a".repeat(1023)}b`;
    expect(atCap.length).toBe(1024);
    expect(BriefSchema.parse(validBrief({ manifestPath: atCap })).manifestPath).toBe(atCap);
    expectRejected(validBrief({ manifestPath: "a".repeat(1025) }), {
      field: "manifestPath",
      code: "too_big",
    });
  });

  test("manifestPath '.' segments stay legal — './pipeline.json' is an ordinary path", () => {
    // Unlike repoSlug, where '.' is an entire owner/repo name and never valid,
    // a '.' path segment resolves nowhere new. Over-rejecting here would refuse
    // briefs that are correct. (An ABSOLUTE path is no longer in this list — see
    // the rejection case above.)
    for (const ok of ["./pipeline.json", "cfg/./pipeline.json"]) {
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

  test("repoUrl HTTPS:// ACCEPTED — URL schemes are case-insensitive", () => {
    // `.url()` accepts it (verified: `new URL("HTTPS://…").protocol === "https:"`),
    // so a case-SENSITIVE prefix check refused a URL that IS https, telling the
    // operator to use the scheme they already used.
    const url = "HTTPS://github.com/owner/repo";
    expect(BriefSchema.parse(validBrief({ repoUrl: url })).repoUrl).toBe(url);
  });

  test("repoUrl at the 2048 cap accepted, one over rejected", () => {
    // The rejecting side alone lets the cap be tightened to anything — 32 would
    // refuse every real clone URL and still pass. The query string keeps the
    // PATHNAME equal to repoSlug, so this exercises the cap, not the cross-check.
    const prefix = "https://github.com/owner/repo?x=";
    const atCap = prefix + "a".repeat(2048 - prefix.length);
    expect(atCap.length).toBe(2048);
    expect(BriefSchema.parse(validBrief({ repoUrl: atCap })).repoUrl).toBe(atCap);
    expectRejected(validBrief({ repoUrl: `${atCap}a` }), { field: "repoUrl", code: "too_big" });
  });

  test("repoUrl must name the SAME repository as repoSlug (spend identity vs. executed code)", () => {
    // repoSlug is the ledger key, the per-issue cap and the host-side log path;
    // repoUrl is what gets cloned and RUN. Validated independently they were
    // attacker-separable: a trusted slug's budget funding someone else's code.
    expectRejected(validBrief({ repoUrl: "https://attacker.example/owner/evil" }), {
      field: "repoUrl",
      code: "custom",
      message: /same repository as repoSlug/,
    });
  });

  test("repoUrl cross-check accepts a .git suffix and a trailing slash", () => {
    for (const ok of ["https://github.com/owner/repo.git", "https://github.com/owner/repo/"]) {
      expect(BriefSchema.parse(validBrief({ repoUrl: ok })).repoUrl).toBe(ok);
    }
  });

  test("the .git strip is case-INSENSITIVE — repo.GIT names the same repository", () => {
    // `canonicalRepoSlug` folds case AROUND a strip that ran case-sensitively,
    // so `…/owner/repo.GIT` kept its suffix, canonicalised to `owner/repo.git`
    // and was refused as a DIFFERENT repository from `owner/repo` — a false
    // rejection of a clone URL git itself accepts. The lowercase `.git` case
    // above passes either way, which is why it could not see this.
    for (const ok of ["https://github.com/owner/repo.GIT", "https://github.com/owner/repo.Git"]) {
      expect(BriefSchema.parse(validBrief({ repoUrl: ok })).repoUrl).toBe(ok);
    }
  });

  test("repoUrl/issueUrl carrying CREDENTIALS refused — every other guard is blind to userinfo", () => {
    // `repoSlugOfUrl` compares `URL.pathname`, which EXCLUDES userinfo, so a
    // GitHub App installation token pasted into the clone URL satisfied
    // `.url()`, the https scheme regex, the 2048 cap AND the slug cross-check —
    // a SECOND secret smuggled into the box (INV-CRED-1) through a field that
    // had passed every check there was. `assertRepoUrl` in `exedev/fill.ts`
    // refuses one too, but that runs AFTER `driver.create()`: a brief this
    // schema can refuse must never burn a billing box INV-5 then forbids
    // destroying. The trust boundary is here.
    for (const url of [
      // The password is a PLACEHOLDER, not a token shape: this fixture asserts
      // on `userinfo` being present at all, so nothing here depends on the value
      // looking issuable — and a literal `ghs_<36 base62>` is what repository
      // secret scanners match, so a fixture wearing that shape costs a push
      // block and a triage cycle for a string that was never a credential. The
      // underscores keep it off `ghs_[A-Za-z0-9]{36}` while the `ghs_` prefix
      // keeps the case recognisable as the clone-URL token the comment names.
      "https://x-access-token:ghs_EXAMPLE_NOT_A_REAL_TOKEN@github.com/owner/repo",
      "https://x-access-token@github.com/owner/repo", // username, no password
      "https://user:@github.com/owner/repo", // password empty but present
    ]) {
      // The cross-check's ENTIRE view of these URLs — identical to the clean one.
      expect(new URL(url).pathname).toBe("/owner/repo");
      expectRejected(validBrief({ repoUrl: url }), {
        field: "repoUrl",
        code: "custom",
        message: /userinfo/,
      });
    }
    // `issueUrl` has no cross-check at all, so nothing else would ever have
    // looked at it — and it lands in run-context.json and in log lines an
    // operator clicks, credentials included.
    expectRejected(validBrief({ issueUrl: "https://user:pw@github.com/owner/repo/issues/1" }), {
      field: "issueUrl",
      code: "custom",
      message: /userinfo/,
    });
  });

  test("an '@' in the PATH is not userinfo — the guard parses, it does not scan", () => {
    // `/@scope/pkg/issues/1` is an ordinary forge path. Implemented as a
    // `url.includes("@")` scan, the rule above refuses it: a false rejection of
    // a correct brief, which is the failure mode a character scan always has.
    const url = "https://github.com/@scope/pkg/issues/1";
    expect(new URL(url).username).toBe("");
    expect(BriefSchema.parse(validBrief({ issueUrl: url })).issueUrl).toBe(url);
  });

  test("control characters in repoUrl/issueUrl rejected on the RAW string — URL STRIPS them", () => {
    // The reason `NO_CONTROL_CHARS` has to be on the field rather than left to
    // the URL guards: WHATWG `URL` DELETES ASCII tab/LF/CR before parsing, so
    // every downstream check sees a clean URL while the operator log stream sees
    // the raw one, newline and all.
    for (const raw of [
      "https://git\nhub.com/owner/repo",
      "https://git\rhub.com/owner/repo",
      "https://git\thub.com/owner/repo",
      "https://github.com/owner/repo\u0000",
      "https://github.com/owner/repo\u001b[2J",
    ]) {
      expectRejected(validBrief({ repoUrl: raw }), {
        field: "repoUrl",
        code: "invalid_string",
        message: /control characters/,
      });
      expectRejected(validBrief({ issueUrl: raw }), {
        field: "issueUrl",
        code: "invalid_string",
        message: /control characters/,
      });
    }
  });

  test("repoUrl cross-check does NOT constrain the host — self-hosted forges are legitimate", () => {
    // The tie is on the PATH only. A host allow-list here would refuse every
    // GitLab/Gitea/Forgejo install, which is a worse failure than the one the
    // cross-check closes.
    const url = "https://git.internal.example.com/owner/repo";
    expect(BriefSchema.parse(validBrief({ repoUrl: url })).repoUrl).toBe(url);
  });

  test("issueUrl HTTPS:// accepted and the 2048 cap binds at the boundary", () => {
    const url = "HTTPS://github.com/owner/repo/issues/1";
    expect(BriefSchema.parse(validBrief({ issueUrl: url })).issueUrl).toBe(url);

    const prefix = "https://github.com/";
    const atCap = prefix + "a".repeat(2048 - prefix.length);
    expect(atCap.length).toBe(2048);
    expect(BriefSchema.parse(validBrief({ issueUrl: atCap })).issueUrl).toBe(atCap);
    expectRejected(validBrief({ issueUrl: `${atCap}a` }), {
      field: "issueUrl",
      code: "too_big",
    });
  });

  test("requestId control characters rejected (log injection into the operator stream)", () => {
    // C3 keeps the FORMAT loose — this is not a UUID check. But the raw value is
    // interpolated into log lines before `resolveRunCorrelation` ever sees it,
    // and a newline forges a whole line there.
    for (const bad of ["abc\nFLEET dispatch ok runId=fake", "abc\rx", "abc\u0000x", "abc\u001bx"]) {
      expectRejected(validBrief({ requestId: bad }), {
        field: "requestId",
        code: "invalid_string",
        message: /control characters/,
      });
    }
  });

  test("requestId at the 128 cap accepted, one over rejected", () => {
    // It rides the brief into the run record, the ledger keys and every log
    // correlation line, all of which are persisted.
    const atCap = "u".repeat(128);
    expect(BriefSchema.parse(validBrief({ requestId: atCap })).requestId).toBe(atCap);
    expectRejected(validBrief({ requestId: "u".repeat(129) }), { field: "requestId", code: "too_big" });
  });

  test("the control-char guard is the Unicode CATEGORY, not an ASCII range — C1 and DEL too", () => {
    // The case above uses C0 and NUL only, all of which an `/[\x00-\x1f]/`
    // rewrite still catches. These four do not: DEL is 0x7f and C1 runs
    // 0x80–0x9f, where U+0085 (NEL) is a line terminator in several log
    // consumers and U+009B (CSI) is the single-byte form of the escape
    // sequence the C0 case is about. `\p{Cc}` is what covers them.
    for (const bad of ["abc\u0085x", "abc\u009bx", "abc\u009fx", "abc\u007fx"]) {
      expectRejected(validBrief({ requestId: bad }), {
        field: "requestId",
        code: "invalid_string",
        message: /control characters/,
      });
    }
  });

  test("the control-char guard reaches the JS line terminators and the bidi overrides too", () => {
    // `\p{Cc}` alone is C0, DEL and C1, which leaves the three classes that
    // forge the very line this guard protects: U+2028/U+2029 are JS LINE
    // TERMINATORS, so a consumer splitting the operator stream with a JS regex
    // — or re-parsing it as a JS string literal — sees a forged record without
    // a `\n` ever appearing; U+202E (RTL override) reorders what a terminal
    // RENDERS without changing a byte, so `runId=fake` can be made to display
    // as something else entirely. The guard is `\p{Cc}\p{Zl}\p{Zp}\p{Cf}`.
    //
    // Narrow it back to `\p{Cc}` — or to an ASCII range — and this goes red.
    for (const risky of ["abc\u2028FLEET dispatch ok runId=fake", "abc\u2029x", "abc\u202ex"]) {
      expectRejected(validBrief({ requestId: risky }), {
        field: "requestId",
        code: "invalid_string",
        message: /control characters/,
      });
    }
  });

  test("requestId '' is refused — neither absent nor usable", () => {
    // `""` is the value that does the most damage, because it is FALSY: a
    // downstream `requestId || mint()` treats it as absent while
    // `Object.hasOwn`/`!== undefined` treat it as present. That split is how the
    // ack, the run record, the ledger key and every log correlation line end up
    // disagreeing about one run, and how concurrent runs carrying it collapse
    // onto a single empty key. Omitting the key is the supported way to say
    // "mint me one" (AC1/AC2); the empty string is not a second spelling of it.
    expectRejected(validBrief({ requestId: "" }), {
      field: "requestId",
      code: "too_small",
      message: /may not be empty/,
    });
  });

  test("a requestId that is only WHITESPACE is refused too — and `.min(1)` alone never saw it", () => {
    // The empty-string argument above, all of it, applies to `"   "` — with one
    // difference that makes it WORSE: `""` is falsy, so a downstream
    // `requestId || mint()` at least rescues it into a fresh id, while `"   "`
    // is TRUTHY and rides all the way through as the correlation id. Every run
    // whose brief carries a run of spaces then collapses onto one ledger key and
    // one log correlation, and no guard anywhere notices: `\p{Zs}` is
    // deliberately outside `NO_CONTROL_CHARS` (a space is not a control
    // character), and the cap, the type check and `.min(1)` all pass it.
    for (const blank of ["   ", "\u00a0", "\u3000", "\u2003"]) {
      expectRejected(validBrief({ requestId: blank }), {
        field: "requestId",
        code: "custom",
        message: /may not be blank/,
      });
    }
  });

  test("every cap counts UTF-16 CODE UNITS — an at-cap value is up to 3× its length in bytes", () => {
    // `.max()` is a `.length` check, and `.length` is UTF-16 units: not bytes,
    // not code points. Every cap case in this file uses ASCII, where all three
    // coincide, so the ceiling the caps actually impose has never been visible.
    // It is a documented ceiling, not a defect — `manifestPath` goes to `fs`,
    // which takes bytes — so it is pinned rather than argued: at the 1024 cap a
    // manifestPath can be 3072 bytes, and 512 astral code points.
    const bmp3 = "漢".repeat(1024); // 3 bytes each, ONE UTF-16 unit each → 3072 bytes
    expect(bmp3.length).toBe(1024); // the fixture is AT the cap, not near it
    expect(BriefSchema.parse(validBrief({ manifestPath: bmp3 })).manifestPath).toBe(bmp3);

    const astral = "\u{1F600}".repeat(512); // 4 bytes each, TWO units each → 512 code points
    expect(astral.length).toBe(1024);
    expect(BriefSchema.parse(validBrief({ manifestPath: astral })).manifestPath).toBe(astral);

    // One more code point is TWO more units, so the cap binds at 1026 — the
    // boundary is on units, and a rewrite to code points would move it.
    expectRejected(validBrief({ manifestPath: `${astral}\u{1F600}` }), {
      field: "manifestPath",
      code: "too_big",
    });
    expect(BriefSchema.parse(validBrief({ requestId: "\u{1F600}".repeat(64) })).requestId).toHaveLength(128);
  });

  test("repoSlug charset is ASCII — a multi-byte slug is refused, not silently canonicalised", () => {
    // The one field where the UTF-16 ceiling above does NOT apply, and it must
    // not: the slug is the ledger key, and `canonicalRepoSlug` folds ASCII only
    // (to match SQLite's `lower()`), so a non-ASCII slug that got through would
    // be a value JS and SQL disagree about the identity of.
    // The cross-check names `repoUrl` too: `repoSlug` no longer matches a URL
    // this case did not touch. That is the refine doing its job, not drift.
    expectRejected(validBrief({ repoSlug: "own\u{1F600}er/repo" }), {
      field: "repoSlug",
      code: "invalid_string",
      alsoNames: ["repoUrl"],
    });
  });

  test("repoSlug invalid pattern rejected (no slash)", () => {
    expectRejected(validBrief({ repoSlug: "justowner" }), {
      field: "repoSlug",
      code: "invalid_string",
      alsoNames: ["repoUrl"], // the cross-check, see the ASCII case above
    });
  });

  test("repoSlug multi-segment (a GitLab subgroup path) rejected", () => {
    // The pattern is deliberately TWO segments (`owner/name`): a forge path with
    // more has never been expressible as a repoSlug, independently of any
    // cross-check. Pinned so a widening of REPO_SLUG_PATTERN — imported from
    // DF1.8, so it could move over there alone — is argued here, not absorbed.
    expectRejected(validBrief({ repoSlug: "group/sub/repo" }), {
      field: "repoSlug",
      code: "invalid_string",
      alsoNames: ["repoUrl"],
    });
  });

  test("repoSlug dot segment rejected (it reaches join() on the ledger key)", () => {
    for (const slug of ["../repo", "./repo"]) {
      expectRejected(validBrief({ repoSlug: slug }), {
        field: "repoSlug",
        code: "custom",
        message: /may not be '\.' or '\.\.'/,
        alsoNames: ["repoUrl"], // the cross-check, see the ASCII case above
      });
    }
  });

  test("repoSlug segments at the 100 cap accepted, 101 rejected (both sides)", () => {
    // Without both directions the `{1,100}` bound is free: `{1,10}` refuses
    // real repositories and `{1,10000}` lets an unbounded slug reach the ledger
    // key and the host-side log path, and every other case in this file passes
    // either way.
    const atCap = "a".repeat(100);
    const atCap2 = "b".repeat(100);
    const slug = `${atCap}/${atCap2}`;
    expect(BriefSchema.parse(validBrief({ repoSlug: slug, repoUrl: `https://github.com/${slug}` })).repoSlug).toBe(
      slug,
    );

    for (const over of [`${"a".repeat(101)}/repo`, `owner/${"b".repeat(101)}`]) {
      expectRejected(validBrief({ repoSlug: over, repoUrl: `https://github.com/${over}` }), {
        field: "repoSlug",
        code: "invalid_string",
      });
    }
  });

  test("repoSlug accepts a realistic long mixed-case slug", () => {
    // 43 chars, mixed case, digits and hyphens: this shape was rejected DEEP in
    // the stack by assertNoSecret's key-shape heuristic, AFTER store.create had
    // already eroded the issue's budget cap. Pinned here so the schema layer
    // cannot start refusing it either.
    const slug = "BiosparkHealth/QDS-Factory-Pipeline-Engine2";
    const result = BriefSchema.parse(validBrief({ repoSlug: slug, repoUrl: `https://github.com/${slug}` }));
    expect(result.repoSlug).toBe(slug);
  });

  test("repoSlug valid pattern accepted", () => {
    // repoUrl moves with it: the two now have to name one repository.
    const brief = validBrief({
      repoSlug: "owner-name/repo.name",
      repoUrl: "https://github.com/owner-name/repo.name",
    });
    const result = BriefSchema.parse(brief);
    expect(result.repoSlug).toBe("owner-name/repo.name");
  });
});

describe("brief fixContext (DF6.1a, C10)", () => {
  const comment = (commentId: string, bodySnippet = "src/a.ts: the bound is off by one") => ({
    commentId,
    author: "qds-review-bot[bot]",
    bodySnippet,
  });

  test("a brief carrying a valid fixContext validates, unchanged otherwise", () => {
    const brief = validBrief({
      fixContext: { schemaVersion: 1, botComments: [comment("1822334455"), comment("1822334456", "")] },
    });
    expect(BriefSchema.parse(brief)).toEqual(brief as Brief);
    // Absent the key, nothing about the pre-DF6.1a brief changes.
    expect(BriefSchema.parse(validBrief())).toEqual(validBrief() as Brief);
  });

  test("21 comments is refused (the count cap is 20)", () => {
    const botComments = Array.from({ length: 21 }, (_, i) => comment(String(i + 1)));
    expectRejected(validBrief({ fixContext: { schemaVersion: 1, botComments } }), {
      field: "fixContext.botComments",
      code: "too_big",
    });
  });

  test("a bodySnippet of 4001 chars is refused (the per-comment cap is 4000)", () => {
    // One over the cap, not a round over it: a cap silently at 4 000 ± drift
    // passes a 4 001 fixture either way, so the AT-cap leg is asserted too.
    expect(BriefSchema.parse(validBrief({ fixContext: { schemaVersion: 1, botComments: [comment("1", "x".repeat(4000))] } })));
    expectRejected(
      validBrief({ fixContext: { schemaVersion: 1, botComments: [comment("1", "x".repeat(4001))] } }),
      { field: "fixContext.botComments.0.bodySnippet", code: "too_big" },
    );
  });

  test("bodySnippets summing past 40 000 UTF-8 bytes are refused — bytes, not chars", () => {
    // 10 × 4 000 ASCII chars = 40 000 bytes exactly: admitted.
    const atBound = Array.from({ length: 10 }, (_, i) => comment(String(i + 1), "x".repeat(4000)));
    expect(BriefSchema.parse(validBrief({ fixContext: { schemaVersion: 1, botComments: atBound } })));
    // 40 001 bytes: the aggregate refine fires while every per-comment cap
    // holds, so only the SUM rule can be doing the refusing.
    const overBound = [...atBound, comment("11", "x")];
    expectRejected(validBrief({ fixContext: { schemaVersion: 1, botComments: overBound } }), {
      field: "fixContext.botComments",
      code: "custom",
      message: /40000-byte UTF-8 total/,
    });
    // "é" is 2 UTF-8 bytes per char: 6 comments × 4 000 chars = 48 000 bytes.
    // A char-counted aggregate admits this; the byte-counted one must not.
    const multibyte = Array.from({ length: 6 }, (_, i) => comment(String(i + 1), "é".repeat(4000)));
    expectRejected(validBrief({ fixContext: { schemaVersion: 1, botComments: multibyte } }), {
      field: "fixContext.botComments",
      code: "custom",
      message: /40000-byte UTF-8 total/,
    });
  });

  test("a non-digit commentId is refused", () => {
    // The id is the loop's dedupe key; a shaped id ("#12", "12.0", "abc") must
    // not pass through to it.
    for (const bad of ["abc", "12.0", "#12", ""]) {
      expectRejected(validBrief({ fixContext: { schemaVersion: 1, botComments: [comment(bad)] } }), {
        field: "fixContext.botComments.0.commentId",
        code: "invalid_string",
      });
    }
  });

  test("a brief carrying any OTHER unregistered key still fails — fixContext does not loosen the strict object", () => {
    // strictObject gives this for free; the leg exists so a future relaxation
    // of the ROOT object (passthrough/catchall) fails here rather than passing
    // because fixContext itself is now registered.
    expectRejected(
      validBrief({
        fixContext: { schemaVersion: 1, botComments: [comment("1")] },
        unknownField: "should-reject",
      }),
      { field: "unknownField", code: "unrecognized_keys" },
    );
    // …and the fixContext object itself is strict for the same reason.
    // `expectRejected`'s unrecognized_keys arm assumes the ROOT (empty path);
    // a nested strict refusal carries path ["fixContext"], so assert it
    // directly: refused, code unrecognized_keys, key named.
    const nested = BriefSchema.safeParse(
      validBrief({ fixContext: { schemaVersion: 1, botComments: [], rawBodies: "nope" } }),
    );
    expect(nested.success).toBe(false);
    const nestedIssue = (nested as { error: ZodError }).error.issues[0];
    expect(nestedIssue?.code).toBe("unrecognized_keys" as never);
    expect(nestedIssue?.path).toEqual(["fixContext"]);
    expect(nestedIssue?.message).toMatch(/rawBodies/);
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
        // `dispatch_task`, not a second `code` phase (DF1.10 C19 removed
        // `engineer`). Nothing in this block asserts a kind, so the choice is
        // free — and a HETEROGENEOUS fixture is worth more than a uniform one
        // here: `roster`/`task` are optional fields only a non-`code` phase
        // carries, so the serialize → reload round-trip below actually proves
        // the serializer preserves kind-specific fields. Two `code` phases
        // could not fail that way. The roster path is never resolved (nothing
        // walks these phases — they are loaded, stamped and re-parsed), so no
        // such file needs to exist.
        {
          name: "plan",
          kind: "dispatch_task",
          description: "Produce the reviewed implementation plan",
          maxDurationMs: 10_000,
          retries: 0,
          roster: "roster.yaml",
          task: "produce the implementation plan",
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
    expect(() => stampManifestLimit(manifest, 1e300)).toThrow(ManifestError);
    expect(() => stampManifestLimit(manifest, 1e300)).toThrow(/positive integer/);
  });

  test("stamped value must be a SAFE integer (reject MAX_SAFE_INTEGER + 2)", () => {
    const manifest = loadManifest(manifestPath, 120_000, manifestDir);
    const tooBig = Number.MAX_SAFE_INTEGER + 2;
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
    //
    // The trailing `\n` is part of the pinned bytes (4a77d7d2): the delivered
    // pipeline.yaml is `cat`-concatenated with run-context.json, and without it
    // the pair glues onto one line. It is re-appended here rather than stripped
    // from the writer — the writer's docblock names this as load-bearing.
    expect(text).toBe(`${JSON.stringify(reparsed, null, 2)}\n`);

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

  /**
   * The AC9a guard's own fixture: a manifest that ARRIVES with a ceiling in it.
   *
   * The shared fixture above never carries `limitMicroUsd`, so every case in
   * this block stamps onto a manifest that had none — and `stripAuthoredLimit`,
   * the guard that exists precisely because an author can put one there, was
   * unexercised. It is not a hypothetical field: `manifestPath` is
   * repo-relative and the repository is attacker-supplied, so a checked-in
   * `"limitMicroUsd": 9007199254740991` is money-path input chosen by whoever
   * opened the issue.
   */
  function authoredLimitManifest(limitMicroUsd: number): string {
    const authoredPath = path.join(manifestDir, "authored.json");
    fs.writeFileSync(authoredPath, JSON.stringify({ ...manifestObj, limitMicroUsd }));
    return authoredPath;
  }

  test("AC9a: an AUTHOR-supplied limitMicroUsd is dropped before the stamp", () => {
    // The loader is deliberately NEUTRAL about this field — the runner reads the
    // already-stamped `pipeline.yaml` back through the same `loadManifest`, and
    // a stamped cap and an authored cap are byte-identical in the file — so the
    // loader must carry it through, and the DISPATCH-side read is what strips
    // it. Both halves are asserted here, because "the loader keeps it" is what
    // makes the strip necessary and is the thing a well-meaning fix would break.
    const authored = Number.MAX_SAFE_INTEGER;
    const loaded = loadManifest(authoredLimitManifest(authored), 120_000, manifestDir);
    expect(loaded.manifest.limitMicroUsd).toBe(authored);

    const stripped = stripAuthoredLimit(loaded);
    expect(stripped.manifest.limitMicroUsd).toBeUndefined();
    // Only that field: a strip that rebuilt the manifest from a subset would
    // silently drop phases, and the engine then runs a different pipeline.
    expect(stripped.manifest.phases).toEqual(loaded.manifest.phases);
    expect(stripped.manifest.pipelineId).toBe(loaded.manifest.pipelineId);
    // Provenance goes with it: these bytes now match no file on disk.
    expect(stripped.resolvedPath).toBeUndefined();
    // The caller's copy is untouched — the loaded manifest is shared.
    expect(loaded.manifest.limitMicroUsd).toBe(authored);

    // End to end: the delivered bytes carry the ADMITTED ceiling and no trace of
    // the authored one.
    const delivered = serializeManifest(stampManifestLimit(stripped, 250_000));
    expect((JSON.parse(delivered) as { limitMicroUsd: number }).limitMicroUsd).toBe(250_000);
    expect(delivered).not.toContain(String(authored));
  });

  test("AC9a: the stamp WINS over an authored ceiling even with the strip skipped", () => {
    // Belt and braces, and the two are independent: `stampManifestLimit` spreads
    // `limitMicroUsd` LAST, so the stamp overrides an authored value on its own.
    // Reorder that spread — put `...manifest.manifest` after the stamp — and the
    // authored ceiling wins on every dispatch that does not strip first. Nothing
    // else in this file would see it.
    const loaded = loadManifest(authoredLimitManifest(9_000_000), 120_000, manifestDir);
    expect(stampManifestLimit(loaded, 250_000).manifest.limitMicroUsd).toBe(250_000);
  });

  test("serializeManifest does NOT require a stamp — the type system will not catch a caller who forgets", () => {
    // TRIPWIRE, NOT A SPECIFICATION, and the shape of the gap is the point:
    // `serializeManifest` takes a `LoadedManifest`, which is the SAME type
    // `loadManifest` returns, so `serializeManifest(loadManifest(…))` compiles
    // and ships a manifest with no ceiling in it at all. `stampManifestLimit`
    // narrows nothing — there is no `StampedManifest` for the serializer to
    // demand — so the only thing standing between a forgotten stamp and an
    // uncapped box is dispatch remembering to call it (pinned end to end by
    // `dispatch.test.ts`'s AC9a/C7 cases and by gate item B, which refuses an
    // unstamped manifest INSIDE the box).
    //
    // If a branded stamped type ever lands, this stops compiling — which is the
    // signal, not a regression. Read it as "the hole is closed", and delete it.
    //
    // KNOWN DEFECT: untyped serializeManifest (no StampedManifest brand to
    // demand). A green run here certifies the unstamped-serialize hole is open
    // — it does not bless shipping without a stamp as supported.
    const loaded = loadManifest(manifestPath, 120_000, manifestDir);
    const unstamped = JSON.parse(serializeManifest(loaded)) as Record<string, unknown>;
    expect(unstamped.limitMicroUsd).toBeUndefined();
    expect(unstamped.phases).toHaveLength(2);
  });

  test("re-stamping is monotonic — a second stamp cannot RAISE the ceiling", () => {
    // The monotonic guard (equal/lower stay legal) is pinned exhaustively in
    // `tests/phase-engine/manifest.test.ts`; here only the raise refusal, since
    // a fleet-side double stamp was the path that could have delivered a higher
    // ceiling than the ledger admitted.
    const loaded = loadManifest(manifestPath, 120_000, manifestDir);
    const once = stampManifestLimit(loaded, 500_000);
    expect(() => stampManifestLimit(once, 9_000_000)).toThrow(
      /refusing to raise limitMicroUsd from 500000 to 9000000/,
    );
    // The refused attempt left the admitted ceiling intact.
    expect(once.manifest.limitMicroUsd).toBe(500_000);
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

// ─── repoUrl ↔ repoSlug, canonical (review round 4) ──────────────────────────

/**
 * The cross-check ties the identity that PAYS (repoSlug — the ledger key and
 * the per-issue cap) to the code that RUNS (repoUrl — what gets cloned inside
 * the box). Comparison is canonical on both sides, and EXACT on the path.
 */
describe("repoUrl/repoSlug cross-check", () => {
  test("a forge that folds case is accepted — the URL names the same repository", () => {
    const brief = validBrief({
      repoSlug: "owner/repo",
      repoUrl: "https://github.com/Owner/Repo",
    });
    expect(BriefSchema.parse(brief).repoUrl).toBe("https://github.com/Owner/Repo");
  });

  test("a slug in one casing and a URL in another name one repository — and NEITHER is rewritten", () => {
    // `not.toThrow()` could not see a TRANSFORM, and the comparison being
    // canonical is exactly what invites one: a schema that canonicalised the
    // fields it compares would hand back a lower-cased `repoSlug`, and the
    // ledger key, the per-issue cap override lookup and `run-context.json`
    // would then carry a slug the operator never wrote — while every casing
    // case in this file still passed. The parsed value is the invariant.
    const brief = validBrief({
      repoSlug: "BiosparkHealth/QDS-Factory",
      repoUrl: "https://github.com/biosparkhealth/qds-factory",
    });
    const parsed = BriefSchema.parse(brief);
    expect(parsed.repoSlug).toBe("BiosparkHealth/QDS-Factory");
    expect(parsed.repoUrl).toBe("https://github.com/biosparkhealth/qds-factory");
    expect(parsed).toEqual(brief as Brief);
  });

  test("a DIFFERENT repository is still refused, whatever the casing", () => {
    expectRejected(validBrief({ repoUrl: "https://github.com/owner/other-repo" }), {
      field: "repoUrl",
      code: "custom",
      message: /same repository/,
    });
    expectRejected(validBrief({ repoUrl: "https://github.com/Attacker/Repo" }), {
      field: "repoUrl",
      code: "custom",
      message: /same repository/,
    });
  });

  test("a path PREFIX does not satisfy the slug — endsWith would admit an attacker's host", () => {
    // https://evil.example/x/owner/repo is the reason the comparison is exact.
    expectRejected(validBrief({ repoUrl: "https://evil.example/x/owner/repo" }), {
      field: "repoUrl",
      code: "custom",
      message: /same repository/,
    });
    expectRejected(validBrief({ repoUrl: "https://github.com/git/owner/repo" }), {
      field: "repoUrl",
      code: "custom",
      message: /same repository/,
    });
  });

  test("a percent-escaped path is refused rather than decoded", () => {
    // %72 is 'r'. The slug charset never needs an escape, so an escaped path
    // does not name a slug-shaped repo — and decoding invites %252e.
    expectRejected(validBrief({ repoUrl: "https://github.com/owner/%72epo" }), {
      field: "repoUrl",
      code: "custom",
      message: /same repository/,
    });
  });

  // Host-unconstrained is asserted once, above the cross-check cases
  // ("repoUrl cross-check does NOT constrain the host…") — a second identical
  // case here was byte-for-byte the same assertion under another name.

  test("KNOWN DEFECT: a repository literally NAMED `repo.git` is falsely refused", () => {
    // SOURCE BUG, pinned rather than accommodated. `repoSlugOfUrl` strips
    // `/\.git$/i` from the URL PATH but `canonicalRepoSlug` does not strip it
    // from the SLUG, so the two sides canonicalise asymmetrically:
    //
    //   repoUrl  https://github.com/owner/repo.git  →  "owner/repo"
    //   repoSlug              owner/repo.git        →  "owner/repo.git"
    //
    // `.` is inside the slug charset `[A-Za-z0-9._-]` and `owner/repo.git` has
    // no `.`/`..` segment, so this is an EXPRESSIBLE, correct brief for a
    // repository whose name ends in `.git` — refused as naming a different
    // repository, with a message that says so and is wrong. The sibling case
    // above ("accepts a .git suffix") only ever exercised the URL carrying a
    // suffix the slug does not have, which is the case the strip is FOR.
    //
    // Not fixed here (this file may not touch `src/`), and not asserted as
    // correct: the assertion below records what the schema does today so the fix
    // — stripping on both sides, or on neither — shows up as this line going
    // red. Deleting the test is the last step of that fix, not a workaround for
    // it.
    expectRejected(
      validBrief({ repoSlug: "owner/repo.git", repoUrl: "https://github.com/owner/repo.git" }),
      { field: "repoUrl", code: "custom", message: /same repository as repoSlug/ },
    );
    // The near-miss that makes the diagnosis unambiguous: drop the suffix from
    // BOTH and the same brief is accepted, so nothing but the asymmetric strip
    // is refusing it.
    const plain = validBrief({ repoSlug: "owner/repo", repoUrl: "https://github.com/owner/repo.git" });
    expect(BriefSchema.parse(plain).repoSlug).toBe("owner/repo");
  });
});
