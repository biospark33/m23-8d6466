/**
 * Leaf-1.1.1 suite — findings schema, harvest normalizer, ADR-2 producer
 * verdict (gates G1/G2; G4's structural half is asserted here too: a
 * normalized finding carries exactly the four pinned keys, so raw box prose
 * has no channel outside `finding_text`).
 */
import { describe, expect, test } from "bun:test";

import { QaVerdictSchema } from "../../src/fleet/auto-merge-policy.ts";
import type { ResultPayload } from "../../src/fleet/result.ts";
import {
  FindingSchema,
  HarvestOutputSchema,
  MAX_QA_LEGS,
  normalizeHarvest,
  QaFindingsError,
  QA_LENS,
  QA_LOG,
  QaVerdictProducerSchema,
} from "../../src/qa/findings.ts";

const RAN: ResultPayload = {
  schemaVersion: 1,
  runId: "qds-20261016-abc123",
  requestId: null,
  status: "completed",
  terminal: true,
  artifacts: {},
};

const HARVEST = {
  schemaVersion: 1,
  lens: "correctness",
  findings: [
    { finding_text: "off-by-one in loop bound", diff_context_ref: "src/loop.ts:42" },
    { finding_text: "missing null guard", diff_context_ref: "src/guard.ts:7" },
  ],
};

describe("G1: finding schema", () => {
  test("accepts a well-formed finding", () => {
    const r = FindingSchema.safeParse({
      runId: "qds-20261016-abc123",
      lens: "correctness",
      finding_text: "off-by-one in loop bound",
      diff_context_ref: "src/loop.ts:42",
    });
    expect(r.success).toBe(true);
  });

  test("AC2 negative control: a finding without (runId, lens) attribution is refused", () => {
    const base = {
      finding_text: "x",
      diff_context_ref: "src/loop.ts:42",
    };
    expect(FindingSchema.safeParse(base).success).toBe(false);
    expect(FindingSchema.safeParse({ ...base, runId: "qds-20261016-abc123" }).success).toBe(false);
    expect(FindingSchema.safeParse({ ...base, lens: "correctness" }).success).toBe(false);
  });

  test("refuses empty prose, unknown keys, and unbounded ids", () => {
    const base = {
      runId: "qds-20261016-abc123",
      lens: "correctness",
      finding_text: "x",
      diff_context_ref: "src/loop.ts:42",
    };
    expect(FindingSchema.safeParse({ ...base, finding_text: "" }).success).toBe(false);
    expect(FindingSchema.safeParse({ ...base, severity: "high" }).success).toBe(false);
    expect(FindingSchema.safeParse({ ...base, diff_context_ref: "has space" }).success).toBe(false);
  });

  test("runId is pinned to the minted qds- shape at the boundary", () => {
    const base = {
      lens: "correctness",
      finding_text: "x",
      diff_context_ref: "src/loop.ts:42",
    };
    // Legacy/foreign id shapes carry no fleet run to attribute to.
    expect(FindingSchema.safeParse({ ...base, runId: "legacy-run-42" }).success).toBe(false);
    expect(FindingSchema.safeParse({ ...base, runId: "qds-2026106-abc123" }).success).toBe(false);
    expect(FindingSchema.safeParse({ ...base, runId: "qds-20261016-ABC123" }).success).toBe(false);
    expect(FindingSchema.safeParse({ ...base, runId: "qds-20261016-abc123" }).success).toBe(true);
  });
});

describe("G1: roster + log vocabulary pins", () => {
  test("QA_LENS / MAX_QA_LEGS pinned per story Technical Notes", () => {
    expect(QA_LENS).toEqual(["correctness", "secret-hygiene", "diff-scope"]);
    expect(MAX_QA_LEGS).toBe(4);
  });

  test("QA_LOG tokens verbatim (story Observability Contract)", () => {
    expect(QA_LOG).toEqual({
      protocolStart: "qa-protocol-start",
      legSubmitted: "qa-leg-submitted",
      legTerminal: "qa-leg-terminal",
      findingsRetained: "qa-findings-retained",
      issuesFiled: "qa-issues-filed",
    });
  });
});

describe("G1: harvest normalizer", () => {
  test("maps a ran leg's harvest to (runId, lens)-attributable findings", () => {
    const n = normalizeHarvest("correctness", RAN, HARVEST);
    expect(n.legRan).toBe(true);
    if (!n.legRan) return; // narrows for tsc
    expect(n.runId).toBe(RAN.runId);
    for (const f of n.findings) {
      expect(f.lens).toBe("correctness");
      expect(f.runId).toBe(RAN.runId);
      expect(FindingSchema.safeParse(f).success).toBe(true);
    }
  });

  test("G4: a normalized finding carries exactly the four pinned keys — no other prose channel", () => {
    const n = normalizeHarvest("correctness", RAN, HARVEST);
    if (!n.legRan) throw new Error("expected legRan");
    const first = n.findings[0];
    if (!first) throw new Error("expected a finding");
    expect(Object.keys(first).sort()).toEqual(
      ["diff_context_ref", "finding_text", "lens", "runId"].sort(),
    );
  });

  test("ran-and-found-none is findings: [], present", () => {
    const n = normalizeHarvest("diff-scope", RAN, { schemaVersion: 1, lens: "diff-scope", findings: [] });
    expect(n).toEqual({ legRan: true, lens: "diff-scope", runId: RAN.runId, findings: [] });
  });

  test("absent-not-0: a leg that did not run carries NO findings array at all", () => {
    for (const leg of [undefined, { ...RAN, status: "running", terminal: false } as ResultPayload, { ...RAN, status: "cancelled", terminal: true } as ResultPayload]) {
      const n = normalizeHarvest("correctness", leg, HARVEST);
      expect(n.legRan).toBe(false);
      expect("findings" in n).toBe(false);
    }
  });

  test("malformed harvest from a ran leg is a named refusal, never passthrough", () => {
    const malformed = [
      { schemaVersion: 1, lens: "correctness" }, // findings missing
      { schemaVersion: 1, lens: "correctness", findings: "none" },
      { lens: "correctness", findings: [] }, // schemaVersion missing
      { ...HARVEST, findings: [{ finding_text: "", diff_context_ref: "a.ts:1" }] },
      { ...HARVEST, verdict: "approved" }, // unknown key: no free-prose side channel
    ];
    for (const h of malformed) {
      try {
        normalizeHarvest("correctness", RAN, h);
        throw new Error("expected refusal");
      } catch (e) {
        expect(e instanceof QaFindingsError).toBe(true);
        expect((e as QaFindingsError).code).toBe("harvest-malformed");
      }
    }
  });

  test("a harvest naming a different lens is refused (no lens mixing)", () => {
    try {
      normalizeHarvest("correctness", RAN, { ...HARVEST, lens: "secret-hygiene" });
      throw new Error("expected refusal");
    } catch (e) {
      expect(e instanceof QaFindingsError).toBe(true);
      expect((e as QaFindingsError).code).toBe("harvest-lens-mismatch");
    }
  });

  test("a lens outside the roster has no leg to attribute to — distinct from a payload/caller mismatch", () => {
    // Caller-lens confusion: the ARGUMENT is not in the roster.
    try {
      normalizeHarvest("style", RAN, HARVEST);
      throw new Error("expected refusal");
    } catch (e) {
      expect(e instanceof QaFindingsError).toBe(true);
      expect((e as QaFindingsError).code).toBe("harvest-unknown-lens");
    }
    // Payload-lens confusion: the caller lens is fine, the HARVEST claims
    // another. Two different failures, two different codes.
    try {
      normalizeHarvest("correctness", RAN, { ...HARVEST, lens: "secret-hygiene" });
      throw new Error("expected refusal");
    } catch (e) {
      expect(e instanceof QaFindingsError).toBe(true);
      expect((e as QaFindingsError).code).toBe("harvest-lens-mismatch");
    }
  });

  test("harvest schema refuses an out-of-roster lens outright", () => {
    expect(HarvestOutputSchema.safeParse({ schemaVersion: 1, lens: "style", findings: [] }).success).toBe(false);
  });
});

describe("G2: ADR-2 producer verdict + consumer tolerance", () => {
  const COMMIT = "a".repeat(40);
  const VERDICT = {
    status: "approved" as const,
    producedAt: "2026-10-16T12:00:00.000Z",
    qaRunId: "qds-20261016-def456",
    commitSha: COMMIT,
    findingCount: 2,
    findingRefs: ["qds-20261016-aaa111", "qds-20261016-bbb222"],
  };

  test("producer schema accepts a well-formed provenance verdict", () => {
    expect(QaVerdictProducerSchema.safeParse(VERDICT).success).toBe(true);
  });

  test("producer refuses malformed provenance", () => {
    expect(QaVerdictProducerSchema.safeParse({ ...VERDICT, commitSha: "A".repeat(40) }).success).toBe(false);
    expect(QaVerdictProducerSchema.safeParse({ ...VERDICT, commitSha: COMMIT.slice(0, 39) }).success).toBe(false);
    expect(QaVerdictProducerSchema.safeParse({ ...VERDICT, findingCount: -1 }).success).toBe(false);
    expect(QaVerdictProducerSchema.safeParse({ ...VERDICT, status: "auto-merged" }).success).toBe(false);
  });

  test("producedAt is pinned ISO-8601, not any Date.parse-parseable string", () => {
    // Loose prose: neither parseable nor ISO.
    expect(QaVerdictProducerSchema.safeParse({ ...VERDICT, producedAt: "soon" }).success).toBe(false);
    // ISO-shaped but off the calendar — Date.parse is NaN, so refused.
    expect(QaVerdictProducerSchema.safeParse({ ...VERDICT, producedAt: "2026-13-45T99:99:99Z" }).success).toBe(false);
    // Valid ISO: Z form and offset form both accepted.
    expect(QaVerdictProducerSchema.safeParse({ ...VERDICT, producedAt: "2026-10-16T12:00:00Z" }).success).toBe(true);
    expect(QaVerdictProducerSchema.safeParse({ ...VERDICT, producedAt: "2026-10-16T12:00:00+02:00" }).success).toBe(true);
  });

  test("consumer tolerance: the produced verdict passes G1's own QaVerdictSchema with extras aboard", () => {
    const r = QaVerdictSchema.safeParse(VERDICT);
    expect(r.success).toBe(true);
  });

  test("the base consumed shape (no extras) also passes both schemas", () => {
    const base = { status: "approved", producedAt: VERDICT.producedAt };
    expect(QaVerdictSchema.safeParse(base).success).toBe(true);
    expect(QaVerdictProducerSchema.safeParse(base).success).toBe(false);
  });
});

describe("mint-side attribution pin", () => {
  test("a ran leg with a legacy/foreign runId is refused at mint — never downstream-only", () => {
    const leg: ResultPayload = {
      schemaVersion: 1, runId: "legacy-run-42", requestId: null,
      status: "completed", terminal: true, artifacts: {},
    };
    const harvest = { schemaVersion: 1, lens: "correctness", findings: [{ finding_text: "defect", diff_context_ref: "src/x.ts:1" }] };
    expect(() => normalizeHarvest("correctness", leg, harvest)).toThrow(QaFindingsError);
    try {
      normalizeHarvest("correctness", leg, harvest);
    } catch (e) {
      expect((e as QaFindingsError).code).toBe("harvest-malformed");
    }
  });
});
