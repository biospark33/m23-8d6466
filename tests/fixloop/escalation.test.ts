/**
 * DF6.1b — the escalation + attempt-budget suite.
 *
 * Pure-function legs over the attempt ladder (deriveAttemptLadder), the two
 * ceilings, the fixOutcome codec (INV-7's JSON-encoded `"string"` shape), and
 * the escalation comment with its PATTERN-redactor egress proof.
 *
 * Ladder legs: terminal classifications (charged / uncharged / once-per-PR /
 * capped / loop-stop), the five approval `state` readings, poll-recovery via a
 * real-sha fixContext, orphaned, and the counts aggregation.
 *
 * Egress leg: an escalation whose CI output carries the canonical ghs_ clone
 * URL, an sk- literal and a PEM block posts NONE of the three (the
 * known-value redactor from cli-anything would post all three — the host token
 * is deliberately absent from process.env, so it cannot see them).
 */
import { describe, expect, test } from "bun:test";

import { RunRecordStore, type RunRecord } from "../../src/providers/run-record.ts";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  buildEscalationComment,
  CHARGED_CLASSES,
  deriveAttemptLadder,
  encodeFixOutcome,
  evaluateCeilings,
  MAX_CHARGED_ATTEMPTS,
  MAX_UNCHARGED_ATTEMPTS,
  ONCE_PER_PR_CLASSES,
  parseFixOutcome,
  parseFixOutcomeClass,
  preflightFixOutcomeWrite,
  type EscalationClass,
} from "../../src/fixloop/escalation.ts";
import { ATTEMPT_SHA_PLACEHOLDER, buildFixContextPayload, encodeFixContext } from "../../src/fixloop/index.ts";

const RUN = (n: number) => `qds-20260930-run${String(n).padStart(4, "0")}`;

// ─── classification sets ─────────────────────────────────────────────────────

describe("classification sets", () => {
  test("only an attempt that reached CI and failed there charges (AC2's opening rule)", () => {
    expect([...CHARGED_CLASSES].sort()).toEqual(["ci-red", "ci-verdict-unavailable"]);
  });

  test("the deterministic refusals are once-per-PR and charge nothing", () => {
    expect([...ONCE_PER_PR_CLASSES].sort()).toEqual(["dispatch-refused", "scope-requires-privilege"]);
  });

  test("parseFixOutcomeClass round-trips the union and refuses foreign strings", () => {
    for (const c of ["green", "ci-red", "transient", "orphaned", "approval-rejected", "out-of-scope-diff", "overflow"] as const) {
      expect(parseFixOutcomeClass(c)).toBe(c);
    }
    expect(parseFixOutcomeClass("made-up")).toBeUndefined();
    expect(parseFixOutcomeClass(42)).toBeUndefined();
  });
});

// ─── the attempt ladder ──────────────────────────────────────────────────────

/** A scratch store plus a record-fixture helper. */
function scratchStore(): RunRecordStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "qds-esc-"));
  return new RunRecordStore({ dir });
}

function baseRecord(store: RunRecordStore, runId: string, extra: Partial<RunRecord["extensions"]> = {}): RunRecord {
  store.create(runId);
  if (Object.keys(extra).length > 0) store.set(runId, { extensions: extra as RunRecord["extensions"] });
  return store.get(runId);
}

function fixContextEncoded(commentIds: string[], attemptSha: string = ATTEMPT_SHA_PLACEHOLDER): string {
  return encodeFixContext(
    buildFixContextPayload({
      prNumber: 7,
      prBranch: "qds/parent1",
      commentIds,
      omittedCommentIds: [],
      omittedCount: 0,
      commentsDigest: "d".repeat(64),
      attemptSha,
    }),
  );
}

describe("deriveAttemptLadder", () => {
  test("a recorded fixOutcomeClass is the terminal arm; its classification decides the budget", () => {
    const store = scratchStore();
    baseRecord(store, RUN(1), { fixLoop: { schemaVersion: 1, fixOutcomeClass: "ci-red" } });
    const { entries, counts } = deriveAttemptLadder((id) => store.get(id), [RUN(1)]);
    expect(entries[0]).toMatchObject({ runId: RUN(1), arm: "terminal", classification: "ci-red" });
    expect(counts.charged).toBe(1);
    expect(counts.uncharged).toBe(0);
  });

  test("charged vs uncharged vs once-per-PR vs capped classes land in the right buckets", () => {
    const store = scratchStore();
    baseRecord(store, RUN(1), { fixLoop: { schemaVersion: 1, fixOutcomeClass: "ci-verdict-unavailable" } });
    baseRecord(store, RUN(2), { fixLoop: { schemaVersion: 1, fixOutcomeClass: "transient" } });
    baseRecord(store, RUN(3), { fixLoop: { schemaVersion: 1, fixOutcomeClass: "lead_failure" } });
    baseRecord(store, RUN(4), { fixLoop: { schemaVersion: 1, fixOutcomeClass: "overflow" } });
    baseRecord(store, RUN(5), { fixLoop: { schemaVersion: 1, fixOutcomeClass: "dispatch-refused" } });
    baseRecord(store, RUN(6), { fixLoop: { schemaVersion: 1, fixOutcomeClass: "scope-requires-privilege" } });
    baseRecord(store, RUN(7), { fixLoop: { schemaVersion: 1, fixOutcomeClass: "out-of-scope-diff" } });
    const { counts } = deriveAttemptLadder((id) => store.get(id), [RUN(1), RUN(2), RUN(3), RUN(4), RUN(5), RUN(6), RUN(7)]);
    expect(counts.charged).toBe(1); // only the CI-reaching failure charges
    expect(counts.uncharged).toBe(3); // transient, lead_failure, overflow
    expect(counts.dispatchRefused).toBe(true);
    expect(counts.scopePrivilege).toBe(true);
    expect(counts.outOfScopeDiff).toBe(1);
  });

  test("the five approval state readings: awaiting-approval and pausing are continuation, never counted", () => {
    const store = scratchStore();
    baseRecord(store, RUN(1), { approval: { schemaVersion: 2, state: "awaiting-approval" } });
    baseRecord(store, RUN(2), { approval: { schemaVersion: 2, state: "pausing" } });
    const { entries, counts } = deriveAttemptLadder((id) => store.get(id), [RUN(1), RUN(2)]);
    expect(entries.map((e) => e.arm)).toEqual(["continuation", "continuation"]);
    expect(counts.uncharged).toBe(0);
    expect(counts.charged).toBe(0);
  });

  test("approval timed-out derives the approval-timed-out classification (uncharged-terminal)", () => {
    const store = scratchStore();
    baseRecord(store, RUN(1), { approval: { schemaVersion: 2, state: "timed-out" } });
    const { entries, counts } = deriveAttemptLadder((id) => store.get(id), [RUN(1)]);
    expect(entries[0]).toMatchObject({ arm: "terminal", classification: "approval-timed-out" });
    expect(counts.uncharged).toBe(1);
    expect(counts.charged).toBe(0);
  });

  test("approval rejected is the operator's decision: terminal, zero-charge, loop stops", () => {
    const store = scratchStore();
    baseRecord(store, RUN(1), { approval: { schemaVersion: 2, state: "rejected" } });
    const { entries, counts } = deriveAttemptLadder((id) => store.get(id), [RUN(1)]);
    expect(entries[0]).toMatchObject({ arm: "terminal", classification: "approval-rejected" });
    expect(counts.approvalRejected).toBe(true);
    expect(counts.charged).toBe(0);
    expect(counts.uncharged).toBe(0);
  });

  test("approved + real-sha fixContext + no terminal outcome is poll recovery, not an attempt", () => {
    const store = scratchStore();
    baseRecord(store, RUN(1), {
      approval: { schemaVersion: 2, state: "approved" },
      fixLoop: { schemaVersion: 1, fixContext: fixContextEncoded(["9001"], "c".repeat(40)) },
    });
    const { entries, counts } = deriveAttemptLadder((id) => store.get(id), [RUN(1)]);
    expect(entries[0]).toMatchObject({ arm: "poll-recovery", runId: RUN(1) });
    expect(counts.uncharged).toBe(0);
  });

  test("approved with NO fixContext and no terminal outcome is the sanctioned re-attempt continuation", () => {
    const store = scratchStore();
    baseRecord(store, RUN(1), { approval: { schemaVersion: 2, state: "approved" } });
    const { entries, counts } = deriveAttemptLadder((id) => store.get(id), [RUN(1)]);
    expect(entries[0]).toMatchObject({ arm: "continuation" });
    expect(counts.uncharged).toBe(0);
  });

  test("a fixContext with no approval state and no terminal outcome is poll-interrupted recovery", () => {
    const store = scratchStore();
    baseRecord(store, RUN(1), { fixLoop: { schemaVersion: 1, fixContext: fixContextEncoded(["9001"], "c".repeat(40)) } });
    const { entries } = deriveAttemptLadder((id) => store.get(id), [RUN(1)]);
    expect(entries[0]).toMatchObject({ arm: "poll-recovery" });
  });

  test("an entry with none of the three arms is orphaned — dead attempt, uncharged ceiling", () => {
    const store = scratchStore();
    baseRecord(store, RUN(1));
    const { entries, counts } = deriveAttemptLadder((id) => store.get(id), [RUN(1)]);
    expect(entries[0]).toMatchObject({ arm: "orphaned", classification: "orphaned" });
    expect(counts.uncharged).toBe(1);
  });

  test("a dangling ledger id is orphaned, never a crash", () => {
    const { entries, counts } = deriveAttemptLadder(
      () => {
        throw new Error("ENOENT");
      },
      [RUN(9)],
    );
    expect(entries[0]).toMatchObject({ runId: RUN(9), arm: "orphaned" });
    expect(counts.uncharged).toBe(1);
  });

  test("terminal outcome wins over the approval state (arm order)", () => {
    const store = scratchStore();
    baseRecord(store, RUN(1), {
      approval: { schemaVersion: 2, state: "approved" },
      fixLoop: { schemaVersion: 1, fixOutcomeClass: "ci-red", fixContext: fixContextEncoded(["9001"], "c".repeat(40)) },
    });
    const { entries } = deriveAttemptLadder((id) => store.get(id), [RUN(1)]);
    expect(entries[0]).toMatchObject({ arm: "terminal", classification: "ci-red" });
  });

  test("the classifications list names every recorded classification for the ceiling escalation", () => {
    const store = scratchStore();
    baseRecord(store, RUN(1), { fixLoop: { schemaVersion: 1, fixOutcomeClass: "transient" } });
    baseRecord(store, RUN(2), { fixLoop: { schemaVersion: 1, fixOutcomeClass: "overflow" } });
    baseRecord(store, RUN(3));
    const { counts } = deriveAttemptLadder((id) => store.get(id), [RUN(1), RUN(2), RUN(3)]);
    expect(counts.classifications.sort()).toEqual(["orphaned", "overflow", "transient"]);
  });
});

// ─── the ceilings ────────────────────────────────────────────────────────────

describe("evaluateCeilings", () => {
  const counts = (over: Partial<Parameters<typeof evaluateCeilings>[0]>): Parameters<typeof evaluateCeilings>[0] => ({
    charged: 0,
    uncharged: 0,
    outOfScopeDiff: 0,
    dispatchRefused: false,
    scopePrivilege: false,
    approvalRejected: false,
    classifications: [],
    ...over,
  });

  test("two charged failures exhaust the charged budget", () => {
    expect(evaluateCeilings(counts({ charged: 2 }))).toEqual(["charged"]);
    expect(evaluateCeilings(counts({ charged: 1 }))).toEqual([]);
  });

  test("three uncharged attempts exhaust the uncharged ceiling — charging-only bounds MUST fail", () => {
    expect(evaluateCeilings(counts({ uncharged: 3 }))).toEqual(["uncharged"]);
  });

  test("one recorded out-of-scope-diff stops the next dispatch (cap 1)", () => {
    expect(evaluateCeilings(counts({ outOfScopeDiff: 1 }))).toEqual(["out-of-scope-diff"]);
  });

  test("once-per-PR refusals stop the loop on their own bound", () => {
    expect(evaluateCeilings(counts({ dispatchRefused: true }))).toEqual(["dispatch-refused"]);
    expect(evaluateCeilings(counts({ scopePrivilege: true }))).toEqual(["scope-requires-privilege"]);
  });

  test("an operator rejection stops the loop", () => {
    expect(evaluateCeilings(counts({ approvalRejected: true }))).toEqual(["approval-rejected"]);
  });

  test("mixed exhaustion lists every violated ceiling", () => {
    expect(evaluateCeilings(counts({ charged: 2, uncharged: 3 })).sort()).toEqual(["charged", "uncharged"]);
  });

  test("the constants are the story's numbers", () => {
    expect(MAX_CHARGED_ATTEMPTS).toBe(2);
    expect(MAX_UNCHARGED_ATTEMPTS).toBe(3);
  });
});

// ─── the fixOutcome codec (INV-7) ────────────────────────────────────────────

describe("fixOutcome codec", () => {
  const payload = {
    schemaVersion: 1 as const,
    prNumber: 7,
    attempts: 2,
    outcome: "green" as const,
    runIds: [RUN(1), RUN(2)],
  };

  test("encode → parse round-trips", () => {
    expect(parseFixOutcome(encodeFixOutcome(payload))).toEqual(payload);
  });

  test("parse refuses non-strings, malformed JSON and unknown shapes — fail closed", () => {
    expect(() => parseFixOutcome({ ...payload })).toThrow(); // an object MUST fail (no object kind)
    expect(() => parseFixOutcome("not json")).toThrow();
    expect(() => parseFixOutcome(JSON.stringify({ ...payload, outcome: "meh" }))).toThrow();
    expect(() => parseFixOutcome(undefined)).toThrow();
  });

  test("the escalated shape carries its classification and the runIds", () => {
    const encoded = encodeFixOutcome({ ...payload, outcome: "escalated", classification: "ci-red" satisfies EscalationClass });
    const parsed = parseFixOutcome(encoded);
    expect(parsed.outcome).toBe("escalated");
    expect(parsed.classification).toBe("ci-red");
    expect(parsed.runIds).toEqual([RUN(1), RUN(2)]);
  });

  test("preflightFixOutcomeWrite validates through a real store before any posting (INV-7)", () => {
    expect(() => preflightFixOutcomeWrite(encodeFixOutcome(payload))).not.toThrow();
    expect(() => preflightFixOutcomeWrite("not json")).toThrow();
  });
});

// ─── the escalation comment ──────────────────────────────────────────────────

describe("buildEscalationComment", () => {
  const GHS = "https://x-access-token:ghs_ABCDEF0123456789abcdef0123456789abcd@github.com/acme/widgets";
  const SK = "sk-0123456789abcdef0123456789abcdef0123456789abcdef";
  const PEM = "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7\n-----END PRIVATE KEY-----";

  test("carries all four diagnostic elements plus the runIds and the classification", () => {
    const body = buildEscalationComment({
      prNumber: 7,
      classification: "ci-red",
      charged: true,
      diagnostics: {
        errorLog: "the fix run's terminal error",
        diffAttempted: ["src/fixloop/ci-status.ts", "tests/fixloop/cli.test.ts"],
        ciFailureMessages: ["ci: build failed (exit 1)"],
        runIds: [RUN(1), RUN(2)],
      },
    });
    expect(body).toMatch(/ci-red/);
    expect(body).toMatch(/charged/);
    expect(body).toMatch(/the fix run's terminal error/);
    expect(body).toMatch(/src\/fixloop\/ci-status\.ts/);
    expect(body).toMatch(/ci: build failed \(exit 1\)/);
    for (const id of [RUN(1), RUN(2)]) expect(body).toContain(id);
  });

  test("EGRESS: ghs_ clone URL, sk- literal and PEM block are ALL redacted before the body exists", () => {
    const body = buildEscalationComment({
      prNumber: 7,
      classification: "ci-red",
      charged: true,
      diagnostics: {
        errorLog: `clone failed: ${GHS}`,
        diffAttempted: [],
        ciFailureMessages: [`provider key ${SK} was echoed by the CI log`, PEM],
        runIds: [RUN(1)],
      },
    });
    expect(body).not.toContain("ghs_");
    expect(body).not.toContain(SK);
    expect(body).not.toContain("BEGIN PRIVATE KEY");
    expect(body).toMatch(/clone failed/); // the non-credential prose survives
  });
});
