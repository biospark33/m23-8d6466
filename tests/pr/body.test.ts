/**
 * The PR body contract (Story DF5.2, AC2 / INV-PR-7).
 */
import { describe, expect, test } from "bun:test";

import {
  BODY_MAX_CHARS,
  CHANGED_FILES_MAX,
  CHECK_ROWS_MAX,
  renderBody,
  renderCostLine,
  renderMicroUsd,
  renderRefusalComment,
} from "../../src/pr/body.ts";
import { sealReport, type ReverifyEvidence, type ReverifyReport } from "../../src/reverify/report.ts";

function report(over: Partial<ReverifyEvidence> = {}): ReverifyReport {
  const evidence: ReverifyEvidence = {
    reverifyId: "rv-run-1",
    runId: "run-1",
    requestId: "req-1",
    headSha: "abc1234",
    baseSha: "def5678",
    startedAt: "2026-08-25T09:59:00.000Z",
    completedAt: "2026-08-25T10:00:00.000Z",
    durationMs: 60_000,
    checks: Array.from({ length: 7 }, (_, i) => ({ item: `check-${i}`, ok: true, note: "exit 0" })),
    testResults: { passed: 7, failed: 0 },
    flags: ["test-files-modified"],
    discrepancies: [],
    claimed: null,
    toolchain: { git: "2.44.0" },
    timings: { worktree_ms: 1, install_ms: 1, tests_ms: 1, gates_ms: 1, cleanup_ms: 1 },
    ...over,
  };
  return sealReport(evidence, {});
}

const approval = { approverId: "steve", decidedAt: "2026-08-25T10:00:01.000Z" };

describe("cost rendering (DD-9)", () => {
  test("integer micro-dollars render to six places with no rounding", () => {
    expect(renderMicroUsd(14_912)).toBe("$0.014912");
    expect(renderMicroUsd(0)).toBe("$0.000000");
    expect(renderMicroUsd(1_000_000)).toBe("$1.000000");
    // The digit a `toFixed(2)` would have thrown away is the whole point.
    expect(renderMicroUsd(1)).toBe("$0.000001");
  });

  test("the line carries the event count and the unpriced count", () => {
    expect(renderCostLine({ totalMicroUsd: 14_912, eventCount: 3, unpricedRows: 0 })).toBe(
      "Cost: $0.014912 (3 events, 0 unpriced)",
    );
    expect(renderCostLine({ totalMicroUsd: 5, eventCount: 1, unpricedRows: 2 })).toBe(
      "Cost: $0.000005 (1 event, 2 unpriced)",
    );
  });

  test("no ledger renders `Cost: unavailable`, which is still a line", () => {
    expect(renderCostLine(null)).toBe("Cost: unavailable");
  });
});

describe("renderBody (AC2)", () => {
  test("every labelled line is present, each on its own line", () => {
    const body = renderBody(
      {
        runId: "run-1",
        report: report(),
        approval,
        issueRef: "Closes #42 (parent #7)",
        cost: { totalMicroUsd: 14_912, eventCount: 3, unpricedRows: 0 },
        changedFiles: ["src.ts", "tests/src.test.ts"],
      },
      {},
    );
    const lines = body.split("\n");
    expect(lines).toContain("Run: run-1");
    expect(lines).toContain("Issue: Closes #42 (parent #7)");
    expect(lines).toContain("Cost: $0.014912 (3 events, 0 unpriced)");
    expect(lines).toContain("Re-verify: green — 7/7 checks");
    expect(lines).toContain("Approved by: steve at 2026-08-25T10:00:01.000Z");
    expect(lines).toContain("Flags: test-files-modified");
    expect(lines).toContain("- src.ts");
  });

  test("an unresolved issue mapping still renders the line (DF5.4-C8 asserts on shape)", () => {
    const body = renderBody(
      { runId: "run-1", report: report(), approval, issueRef: "unresolved", cost: null, changedFiles: [] },
      {},
    );
    expect(body.split("\n")).toContain("Issue: unresolved");
  });

  test("failing check names ride on the verdict line", () => {
    const red = report({
      checks: [
        { item: "install", ok: true, note: "exit 0" },
        { item: "tests: bun test", ok: false, note: "exit 1" },
      ],
      testResults: { passed: 6, failed: 1 },
    });
    const body = renderBody(
      { runId: "run-1", report: red, approval, issueRef: "unresolved", cost: null, changedFiles: [] },
      {},
    );
    expect(body).toContain("Re-verify: red — 1/2 checks (failing: tests: bun test)");
  });

  test("the check table caps at 50 rows and the file list at 100 paths", () => {
    const many = report({
      checks: Array.from({ length: 80 }, (_, i) => ({ item: `check-${i}`, ok: true, note: "exit 0" })),
    });
    const files = Array.from({ length: 140 }, (_, i) => `src/file-${i}.ts`);
    const body = renderBody(
      { runId: "run-1", report: many, approval, issueRef: "unresolved", cost: null, changedFiles: files },
      {},
    );
    expect(body).toContain(`+${80 - CHECK_ROWS_MAX} more`);
    expect(body).toContain(`+${140 - CHANGED_FILES_MAX} more`);
    expect(body).not.toContain("- ok — check-50");
    expect(body).not.toContain("- src/file-100.ts");
  });

  test("the cap counts the truncation suffix (GitHub's ceiling is 65,536)", () => {
    const files = Array.from({ length: CHANGED_FILES_MAX }, () => `src/${"x".repeat(2_000)}.ts`);
    const body = renderBody(
      { runId: "run-1", report: report(), approval, issueRef: "unresolved", cost: null, changedFiles: files },
      {},
    );
    expect(body.length).toBeLessThanOrEqual(BODY_MAX_CHARS);
    expect(body).toContain("chars total]");
  });
});

describe("INV-PR-7 — redaction at the construction boundary", () => {
  const SENTINEL = "sentinel-secret-value-abc123";

  test("a secret planted in a body input never reaches the rendered body", () => {
    // The sentinel rides in on a re-verify note — a body INPUT, not the
    // environment. An implementation redacting against `process.env` fails
    // here, because the sentinel is deliberately not in `process.env`.
    expect(process.env.QDS_PR_SENTINEL_TOKEN).toBeUndefined();
    const withSecret = report({
      checks: [{ item: "install", ok: true, note: `failed to auth with ${SENTINEL}` }],
      testResults: { passed: 1, failed: 0 },
    });
    const body = renderBody(
      {
        runId: "run-1",
        report: withSecret,
        approval,
        issueRef: `unresolved ${SENTINEL}`,
        cost: null,
        changedFiles: [`src/${SENTINEL}.ts`],
      },
      { QDS_PR_SENTINEL_TOKEN: SENTINEL },
    );
    expect(body).not.toContain(SENTINEL);
    expect(body).toContain("[REDACTED:QDS_PR_SENTINEL_TOKEN]");
  });

  test("the refusal comment goes through the same map", () => {
    const comment = renderRefusalComment(
      "run-1",
      {
        failedPrecondition: "reverify-red",
        failingChecks: ["tests: bun test"],
        reportPath: ".sandbox/reverify/run-1.jsonl",
        message: `push refused, token ${SENTINEL}`,
      },
      { QDS_PR_SENTINEL_TOKEN: SENTINEL },
    );
    expect(comment).not.toContain(SENTINEL);
    expect(comment).toContain("Failing checks: tests: bun test");
    expect(comment).toContain("Nothing was pushed.");
  });
});

describe("INV-PR-7 — the redaction map is validated, not just applied", () => {
  const secret = "ghp_0123456789abcdef";

  const input = (over: Partial<Parameters<typeof renderBody>[0]> = {}): Parameters<typeof renderBody>[0] => ({
    runId: "run-1",
    report: report(),
    approval,
    issueRef: "Closes #42",
    cost: null,
    changedFiles: ["src.ts"],
    ...over,
  });

  test("a key `redactSecrets` cannot see is refused at both render boundaries", () => {
    // `hostCredential` matches CRED, so it IS visible. `hostPat` is not.
    const invisible = { hostPat: secret };
    expect(() => renderBody(input({}), invisible)).toThrow(/invisible to redactSecrets/);
    expect(() =>
      renderRefusalComment("run-1", { failedPrecondition: "x", failingChecks: [], reportPath: "p", message: secret }, invisible),
    ).toThrow(/invisible to redactSecrets/);
  });

  test("a correctly named key still redacts, in the body and in the refusal comment", () => {
    const map = { QDS_PR_TOKEN: secret };
    const body = renderBody(input({ issueRef: `see ${secret}` }), map);
    expect(body).not.toContain(secret);
    expect(body).toContain("[REDACTED:QDS_PR_TOKEN]");

    const comment = renderRefusalComment(
      "run-1",
      { failedPrecondition: "x", failingChecks: [], reportPath: "p", message: `push failed: ${secret}` },
      map,
    );
    expect(comment).not.toContain(secret);
    expect(comment).toContain("[REDACTED:QDS_PR_TOKEN]");
  });

  test("a value below redactSecrets' floor is not refused — there is nothing to promise", () => {
    expect(() => renderBody(input({}), { hostPat: "short" })).not.toThrow();
  });
});
