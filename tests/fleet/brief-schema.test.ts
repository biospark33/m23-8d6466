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
  type Brief,
} from "../../src/fleet/brief-schema.ts";
import {
  loadManifest,
  ManifestError,
  PipelineManifestSchema,
  stampManifestLimit,
  serializeManifest,
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

  test("a hostile unknown-key NAME is refused, and the extractor returns it VERBATIM", () => {
    // Every other unknown-key case uses a benign name, so nothing here has ever
    // exercised the fact that the key is ATTACKER-CHOSEN: a brief is
    // attacker-authored JSON, and `NO_CONTROL_CHARS` guards VALUES — no rule
    // anywhere constrains a key NAME. `extractZodErrorField` returns it with no
    // transformation, and `dispatch.ts` interpolates that twice into the
    // operator stream (`JSON.stringify(field)` in the message, RAW in the
    // remediation), while zod's own issue message quotes it raw as well.
    //
    // What this layer OWNS is the refusal, and that is what is asserted: the
    // brief is rejected before any box, key or ledger row exists, whatever the
    // name renders as. The verbatim return is pinned so the escaping obligation
    // sits visibly on the consumer. That obligation is now met — `dispatch.ts`
    // escapes the name in the message, the remediation AND the issues array;
    // see the dispatch-layer test that pins it.
    for (const hostile of ["\u001b[2Jrm -rf", "a\nFLEET dispatch ok runId=fake"]) {
      expectRejected(validBrief({ [hostile]: "x" }), {
        field: hostile,
        code: "unrecognized_keys",
      });
    }
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
      expectRejected(brief, { field: key, code: "unrecognized_keys" });
    }
    // …and nothing was polluted on the way through.
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  test("a non-object brief is refused and NAMED — the root label, not an empty field", () => {
    // The case the extractor's docblock was written for: a root rejection
    // carries an EMPTY path, and AC1's "exits 2 naming the offending field"
    // becomes `field ` — nothing an operator can act on.
    for (const notAnObject of ["not an object", null, 42, ["repoSlug"]]) {
      const result = BriefSchema.safeParse(notAnObject);
      expect(result.success).toBe(false);
      const error = (result as { error: ZodError }).error;
      expect(error.issues[0]?.code).toBe("invalid_type");
      expect(error.issues[0]?.path).toEqual([]);
      expect(extractZodErrorField(error)).toBe(ROOT_FIELD_LABEL);
      expect(ROOT_FIELD_LABEL.length).toBeGreaterThan(0);
    }
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
      "https://x-access-token:ghs_16C7e42F292c6912E7710c838347Ae178B4a@github.com/owner/repo",
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
    // the raw one, newline and all. The assertion below is the proof — the
    // forged value parses to a perfectly ordinary href.
    expect(new URL("https://git\nhub.com/owner/repo").href).toBe("https://github.com/owner/repo");
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

  test("every cap counts UTF-16 CODE UNITS — an at-cap value is up to 3× its length in bytes", () => {
    // `.max()` is a `.length` check, and `.length` is UTF-16 units: not bytes,
    // not code points. Every cap case in this file uses ASCII, where all three
    // coincide, so the ceiling the caps actually impose has never been visible.
    // It is a documented ceiling, not a defect — `manifestPath` goes to `fs`,
    // which takes bytes — so it is pinned rather than argued: at the 1024 cap a
    // manifestPath can be 3072 bytes, and 512 astral code points.
    const bmp3 = "漢".repeat(1024); // 3 bytes each, ONE UTF-16 unit each
    expect(bmp3.length).toBe(1024);
    expect(Buffer.byteLength(bmp3)).toBe(3072);
    expect(BriefSchema.parse(validBrief({ manifestPath: bmp3 })).manifestPath).toBe(bmp3);

    const astral = "\u{1F600}".repeat(512); // 4 bytes each, TWO UTF-16 units each
    expect(astral.length).toBe(1024);
    expect([...astral]).toHaveLength(512);
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
    expectRejected(validBrief({ repoSlug: "own\u{1F600}er/repo" }), {
      field: "repoSlug",
      code: "invalid_string",
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

  test("the host is deliberately unconstrained — self-hosted forges stay legitimate", () => {
    const url = "https://git.internal.example.com/owner/repo";
    expect(BriefSchema.parse(validBrief({ repoUrl: url })).repoUrl).toBe(url);
  });
});
