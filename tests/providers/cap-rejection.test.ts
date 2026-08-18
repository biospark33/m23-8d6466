/**
 * DF2.4 — CAP-based hit/kill classification and redaction.
 *
 * AC2: overflow classification iff usage >= cap AND providerCapRejected===true
 *      AND terminationProvenance is NOT "wall-clock" or "host-error".
 * AC5: redactWithKey replaces >=8-char substrings of secret with [REDACTED].
 *
 * Module under test does NOT exist yet — this is TDD RED phase.
 */

import { describe, expect, test } from "bun:test";
import { classifyRunExit, redactWithKey, type InBoxExit, type TerminationProvenance } from "../../src/providers/cap-rejection.ts";
import { EXIT_STATUSES } from "../../cli-anything/src/types.ts";

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Any >=8-char substring of the secret found in any corpus, else null. */
function leakScan(secret: string, ...corpora: string[]): string | null {
  for (let i = 0; i + 8 <= secret.length; i++) {
    const frag = secret.slice(i, i + 8);
    for (const corpus of corpora) {
      if (corpus.includes(frag)) return frag;
    }
  }
  return null;
}

/** Scan JSON-stringified artifact for leaked secret fragments. */
function scanArtifactForLeak(secret: string, artifact: unknown): string | null {
  return leakScan(secret, JSON.stringify(artifact));
}

// ─── AC2: overflow classification truth table ────────────────────────────────

describe("AC2: overflow mapping when usage >= cap + rejected + valid provenance", () => {
  const capMicroUsd = 50_000_000;
  const usageMicroUsd = 55_000_000; // >= cap

  test.each([
    ["transient" as InBoxExit],
    ["logic" as InBoxExit],
    ["lead_failure" as InBoxExit],
  ])("inBoxExit=%s with provider-cap provenance -> overflow", (inBoxExit) => {
    const result = classifyRunExit({
      inBoxExit,
      usageMicroUsd,
      capMicroUsd,
      providerCapRejected: true,
      terminationProvenance: "provider-cap",
    });
    expect(result).toEqual({ exitStatus: "overflow", killOrigin: "provider-cap" });
  });

  test("null provenance (also valid) -> overflow", () => {
    const result = classifyRunExit({
      inBoxExit: "transient",
      usageMicroUsd,
      capMicroUsd,
      providerCapRejected: true,
      terminationProvenance: null,
    });
    expect(result).toEqual({ exitStatus: "overflow", killOrigin: "provider-cap" });
  });

  test("boundary: usage === cap exactly -> overflow", () => {
    const result = classifyRunExit({
      inBoxExit: "logic",
      usageMicroUsd: capMicroUsd, // exactly equal
      capMicroUsd,
      providerCapRejected: true,
      terminationProvenance: "provider-cap",
    });
    expect(result).toEqual({ exitStatus: "overflow", killOrigin: "provider-cap" });
  });
});

describe("AC2 negative: passthrough when providerCapRejected is false", () => {
  const capMicroUsd = 50_000_000;
  const usageMicroUsd = 55_000_000; // >= cap

  test.each([
    ["transient" as InBoxExit, "provider-cap" as TerminationProvenance],
    ["logic" as InBoxExit, "wall-clock" as TerminationProvenance],
    ["lead_failure" as InBoxExit, null],
  ])("inBoxExit=%s, provenance=%s -> passthrough", (inBoxExit, provenance) => {
    const result = classifyRunExit({
      inBoxExit,
      usageMicroUsd,
      capMicroUsd,
      providerCapRejected: false, // key difference
      terminationProvenance: provenance,
    });
    expect(result).toEqual({ exitStatus: inBoxExit, killOrigin: provenance });
  });
});

describe("AC2 negative: wall-clock or host-error provenance overrides even when rejected", () => {
  const capMicroUsd = 50_000_000;
  const usageMicroUsd = 55_000_000;

  test.each([
    ["wall-clock" as TerminationProvenance],
    ["host-error" as TerminationProvenance],
  ])("provenance=%s with providerCapRejected=true -> passthrough", (provenance) => {
    const result = classifyRunExit({
      inBoxExit: "transient",
      usageMicroUsd,
      capMicroUsd,
      providerCapRejected: true, // rejected flag ignored
      terminationProvenance: provenance, // takes precedence
    });
    expect(result).toEqual({ exitStatus: "transient", killOrigin: provenance });
  });
});

describe("usage < cap: always passthrough regardless of other flags", () => {
  const capMicroUsd = 50_000_000;
  const usageMicroUsd = 45_000_000; // < cap

  test("usage under cap with rejected=true -> passthrough", () => {
    const result = classifyRunExit({
      inBoxExit: "logic",
      usageMicroUsd,
      capMicroUsd,
      providerCapRejected: true,
      terminationProvenance: "provider-cap",
    });
    expect(result).toEqual({ exitStatus: "logic", killOrigin: "provider-cap" });
  });

  test("usage under cap with rejected=false -> passthrough", () => {
    const result = classifyRunExit({
      inBoxExit: "lead_failure",
      usageMicroUsd,
      capMicroUsd,
      providerCapRejected: false,
      terminationProvenance: null,
    });
    expect(result).toEqual({ exitStatus: "lead_failure", killOrigin: null });
  });
});

describe("AC2: host evidence outranks box claim when success but rejected+over-cap", () => {
  const capMicroUsd = 50_000_000;
  const usageMicroUsd = 55_000_000;

  test("inBoxExit=success with usage>=cap+rejected -> override to overflow", () => {
    const result = classifyRunExit({
      inBoxExit: "success", // box claimed success
      usageMicroUsd,
      capMicroUsd,
      providerCapRejected: true, // but host observed rejection
      terminationProvenance: "provider-cap",
    });
    expect(result).toEqual({ exitStatus: "overflow", killOrigin: "provider-cap" });
  });

  test("inBoxExit=success with wall-clock provenance -> NOT overflow (wall-clock wins)", () => {
    const result = classifyRunExit({
      inBoxExit: "success",
      usageMicroUsd,
      capMicroUsd,
      providerCapRejected: true,
      terminationProvenance: "wall-clock", // wall-clock provenance overrides
    });
    expect(result).toEqual({ exitStatus: "success", killOrigin: "wall-clock" });
  });
});

// ─── CC-1 mirror sync ─────────────────────────────────────────────────────────

describe("CC-1 mirror sync: InBoxExit union matches cli-anything EXIT_STATUSES", () => {
  test("InBoxExit type mirrors EXIT_STATUSES exactly", () => {
    // Expected literal array derived from AC contract
    const expected = ["lead_failure", "logic", "overflow", "success", "transient"] as const;
    const actual = [...EXIT_STATUSES].sort(); // spread to allow sort
    expect(actual as readonly string[]).toEqual(expected);
  });
});

// ─── AC5: redactWithKey ───────────────────────────────────────────────────────

describe("AC5: redactWithKey replaces >=8-char secret substrings with [REDACTED]", () => {
  const secret = "sk-or-v1-abcdefgh1234567890";

  test("full secret embedded in text -> replaced once per occurrence", () => {
    const text = `Key is ${secret} and again ${secret}`;
    const result = redactWithKey(text, secret);
    expect(result).toBe("Key is [REDACTED] and again [REDACTED]");
  });

  test("8-char prefix substring -> redacted", () => {
    const prefix = secret.slice(0, 8); // "sk-or-v1"
    const text = `Contains ${prefix} inside`;
    const result = redactWithKey(text, secret);
    expect(result).toBe("Contains [REDACTED] inside");
  });

  test("7-char substring -> NOT redacted (below threshold)", () => {
    const short = secret.slice(0, 7); // "sk-or-v"
    const text = `Contains ${short} inside`;
    const result = redactWithKey(text, secret);
    expect(result).toBe(text); // unchanged
  });

  test("8-char middle substring -> redacted", () => {
    const middle = secret.slice(5, 13); // "v1-abcde"
    const text = `Contains ${middle} inside`;
    const result = redactWithKey(text, secret);
    expect(result).toBe("Contains [REDACTED] inside");
  });

  test("text without any >=8-char overlap -> returned verbatim", () => {
    const text = "No secret fragments here abc12345";
    const result = redactWithKey(text, secret);
    expect(result).toBe(text);
  });

  test("secret shorter than 8 chars -> text returned verbatim", () => {
    const shortSecret = "abc";
    const text = "Contains abc inside";
    const result = redactWithKey(text, shortSecret);
    expect(result).toBe(text);
  });

  test("artifact-scan: JSON object with redacted body shows zero leaks", () => {
    const redacted = { key: "[REDACTED]", message: "My key is [REDACTED]" };
    const leak = scanArtifactForLeak(secret, redacted);
    expect(leak).toBeNull();
  });

  test("artifact-scan: unredacted object shows leak", () => {
    const unsafe = { key: secret };
    const leak = scanArtifactForLeak(secret, unsafe);
    expect(leak).toBeTruthy();
    expect(leak).toHaveLength(8);
  });
});

// ─── Classifier purity ───────────────────────────────────────────────────────

describe("Classifier purity: deterministic output for same input", () => {
  test("calling classifyRunExit twice with same input returns identical results", () => {
    const input = {
      inBoxExit: "transient" as InBoxExit,
      usageMicroUsd: 55_000_000,
      capMicroUsd: 50_000_000,
      providerCapRejected: true,
      terminationProvenance: "provider-cap" as TerminationProvenance,
    };
    const result1 = classifyRunExit(input);
    const result2 = classifyRunExit(input);
    expect(result1).toEqual(result2);
  });

  test("calling redactWithKey twice with same input returns identical results", () => {
    const text = "Key is sk-or-v1-abcdefgh1234567890";
    const secret = "sk-or-v1-abcdefgh1234567890";
    const result1 = redactWithKey(text, secret);
    const result2 = redactWithKey(text, secret);
    expect(result1).toBe(result2);
  });
});
