import { describe, expect, test } from "bun:test";

import {
  resolveBankIdOrError,
  parseArgs,
} from "../scripts/import-mulch-expertise.ts";
import { ERR_BANK_ID_INVALID } from "../src/hindsight/schemas.ts";

// ---------------------------------------------------------------------------
// Fix [9]: CLI bank_id validation
// ---------------------------------------------------------------------------

describe("import-mulch-expertise CLI — fix [9] resolveBankIdOrError", () => {
  test("valid repoSlug → derived <slug>-dev-meta id returned", () => {
    const r = resolveBankIdOrError("QDS-Factory", undefined);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.bankId).toBe("qds-factory-dev-meta");
  });

  test("explicit --bank-id (valid) → used as-is", () => {
    const r = resolveBankIdOrError("anything", "my-explicit-bank");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.bankId).toBe("my-explicit-bank");
  });

  test("repoSlug '!!!!' → resolveBankId returns '' → '-dev-meta' invalid → -32003 envelope", () => {
    // Sanity: derived id "-dev-meta" fails BankIdSchema (leading hyphen).
    const r = resolveBankIdOrError("!!!!", undefined);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe(ERR_BANK_ID_INVALID);
    expect(r.error.message).toBe("Invalid bank ID derived from repo slug");
  });

  test("explicit --bank-id invalid (uppercase) → -32003", () => {
    // BankIdSchema requires lowercase; uppercase rejected.
    const r = resolveBankIdOrError("ok", "Invalid_Uppercase");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe(ERR_BANK_ID_INVALID);
  });

  test("empty explicit bankId falls through to default derivation", () => {
    // An empty string is treated as "not provided" → default path runs.
    const r = resolveBankIdOrError("QDS-Factory", "");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.bankId).toBe("qds-factory-dev-meta");
  });
});

describe("import-mulch-expertise CLI — parseArgs", () => {
  test("parses --expertise-dir, --repo-slug, --bank-id", () => {
    const a = parseArgs([
      "--expertise-dir", "/tmp/x",
      "--repo-slug", "my-repo",
      "--bank-id", "custom-bank",
    ]);
    expect(a.expertiseDir).toBe("/tmp/x");
    expect(a.repoSlug).toBe("my-repo");
    expect(a.bankId).toBe("custom-bank");
  });

  test("defaults: expertiseDir='.mulch/expertise', bankId empty", () => {
    const a = parseArgs([]);
    expect(a.expertiseDir).toBe(".mulch/expertise");
    expect(a.bankId).toBe("");
  });

  test("value flag with no value throws (no silent default) [Review R2 L1]", () => {
    // A bare `--expertise-dir` (missing value) is a typo, not a request for
    // the default dir. parseArgs must throw rather than silently import from
    // `.mulch/expertise`.
    expect(() => parseArgs(["--expertise-dir"])).toThrow(/requires a non-empty value/);
    expect(() => parseArgs(["--repo-slug", ""])).toThrow(/requires a non-empty value/);
    // A flag-looking value (`--bank-id --repo-slug`) is also rejected.
    expect(() => parseArgs(["--bank-id", "--repo-slug"])).toThrow(/requires a non-empty value/);
  });
});
