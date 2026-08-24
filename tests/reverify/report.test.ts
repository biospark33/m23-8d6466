/**
 * ReverifyReport contract tests (Story DF5.1).
 *
 * The verdict is DERIVED inside report.ts from the evidence — there is no
 * setter reachable from outside this module (INV-RV-5). Zero checks is red,
 * zero executed tests is red, any failure is error, and error is never green.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  NOTE_MAX_CHARS,
  CHECKS_MAX,
  appendReport,
  readReports,
  sealReport,
  type ReverifyEvidence,
} from "../../src/reverify/report.ts";

function evidence(over: Partial<ReverifyEvidence> = {}): ReverifyEvidence {
  return {
    reverifyId: "rv-1",
    runId: "run-1",
    requestId: "req-1",
    headSha: "a".repeat(40),
    baseSha: "b".repeat(40),
    startedAt: "2026-08-24T00:00:00.000Z",
    completedAt: "2026-08-24T00:00:01.000Z",
    durationMs: 1000,
    checks: [{ item: "tests", ok: true, note: "exit 0" }],
    testResults: { passed: 12, failed: 0 },
    flags: [],
    discrepancies: [],
    claimed: null,
    toolchain: { git: "2.43.0" },
    timings: { worktree_ms: 1, install_ms: 2, tests_ms: 3, gates_ms: 4, cleanup_ms: 5 },
    ...over,
  };
}

describe("sealReport verdict derivation", () => {
  test("green needs both a completed test result and at least one check", () => {
    expect(sealReport(evidence(), {}).verdict).toBe("green");
  });

  test("zero checks is red with reason nothing-to-verify, never vacuously green", () => {
    const r = sealReport(evidence({ checks: [] }), {});
    expect(r.verdict).toBe("red");
    expect(r.reason).toBe("nothing-to-verify");
  });

  test("zero executed tests is red with reason no-tests-executed", () => {
    const r = sealReport(evidence({ testResults: { passed: 0, failed: 0 } }), {});
    expect(r.verdict).toBe("red");
    expect(r.reason).toBe("no-tests-executed");
  });

  test("a host-declared no-test-suite repository is green on its non-test checks alone", () => {
    const r = sealReport(evidence({ testResults: { passed: 0, failed: 0 }, noTestSuite: true }), {});
    expect(r.verdict).toBe("green");
  });

  test("noTestSuite still cannot make an empty check set green", () => {
    const r = sealReport(
      evidence({ testResults: { passed: 0, failed: 0 }, noTestSuite: true, checks: [] }),
      {},
    );
    expect(r.verdict).toBe("red");
    expect(r.reason).toBe("nothing-to-verify");
  });

  test("a failing check is red", () => {
    const r = sealReport(
      evidence({ checks: [{ item: "lint", ok: false, note: "exit 1" }] }),
      {},
    );
    expect(r.verdict).toBe("red");
  });

  test("a failed test count is red even with all checks green", () => {
    expect(sealReport(evidence({ testResults: { passed: 11, failed: 1 } }), {}).verdict).toBe("red");
  });

  test("nondeterministic forces red", () => {
    const r = sealReport(evidence({ nondeterministic: true }), {});
    expect(r.verdict).toBe("red");
    expect(r.flags).toContain("nondeterministic");
  });

  test("a failure yields error, and error is never green", () => {
    const r = sealReport(
      evidence({ failure: { code: "toolchain-missing", message: "no bun", remediation: "install bun" } }),
      {},
    );
    expect(r.verdict).toBe("error");
    expect(r.reason).toBe("toolchain-missing");
    expect(r.verdict === "green").toBe(false);
  });

  test("a failure outranks otherwise-green evidence", () => {
    const r = sealReport(
      evidence({ failure: { code: "wall-clock", message: "cap hit", remediation: "raise cap" } }),
      {},
    );
    expect(r.verdict).toBe("error");
  });

  test("discrepancies alone never lower or raise the verdict", () => {
    const r = sealReport(evidence({ discrepancies: ["testResults.failed: claimed 3, host 0"] }), {});
    expect(r.verdict).toBe("green");
  });

  test("a claimed success against a red host verdict is enumerated, not obeyed", () => {
    const r = sealReport(
      evidence({
        testResults: { passed: 11, failed: 1 },
        claimed: { exitStatus: "success", testResults: { passed: 12, failed: 0 }, changedFiles: [] },
      }),
      {},
    );
    expect(r.verdict).toBe("red");
    expect(r.discrepancies).toContain('exitStatus: claimed "success", host verdict red');
  });

  test("a claimed failure against a green host verdict is recorded the same way", () => {
    const r = sealReport(
      evidence({ claimed: { exitStatus: "logic", testResults: { passed: 0, failed: 3 }, changedFiles: [] } }),
      {},
    );
    expect(r.verdict).toBe("green");
    expect(r.discrepancies).toContain('exitStatus: claimed "logic", host verdict green');
  });

  test("an in-box claim cannot raise a red verdict", () => {
    const r = sealReport(
      evidence({
        checks: [{ item: "tests", ok: false, note: "exit 1" }],
        claimed: { exitStatus: "success", testResults: { passed: 12, failed: 0 }, changedFiles: ["a.ts"] },
      }),
      {},
    );
    expect(r.verdict).toBe("red");
  });
});

describe("sealReport boundary hygiene", () => {
  test("rejects an undeclared field rather than silently writing it", () => {
    const bad = { ...evidence(), sneaky: true } as unknown as ReverifyEvidence;
    expect(() => sealReport(bad, {})).toThrow(/sneaky/);
  });

  test("redacts notes against the supplied purpose-built map, not process.env", () => {
    const secret = "sentinel-secret-value-123456";
    const r = sealReport(
      evidence({ checks: [{ item: "tests", ok: true, note: `leaked ${secret} here` }] }),
      { QDS_PROVIDER_KEY: secret },
    );
    expect(r.checks[0]!.note).not.toContain(secret);
    expect(r.checks[0]!.note).toContain("[REDACTED:QDS_PROVIDER_KEY]");
  });

  test("redacts the failure message too", () => {
    const secret = "sentinel-secret-value-123456";
    const r = sealReport(
      evidence({ failure: { code: "spawn", message: `token ${secret}`, remediation: "retry" } }),
      { GITHUB_TOKEN: secret },
    );
    expect(JSON.stringify(r)).not.toContain(secret);
  });

  test("caps a note at NOTE_MAX_CHARS including the truncation suffix", () => {
    const r = sealReport(
      evidence({ checks: [{ item: "tests", ok: true, note: "x".repeat(5_000) }] }),
      {},
    );
    const note = r.checks[0]!.note;
    expect(note.length).toBeLessThanOrEqual(NOTE_MAX_CHARS);
    expect(note).toMatch(/\[truncated, 5000 chars total\]$/);
  });

  test("caps the checks array at CHECKS_MAX and flags the truncation", () => {
    const many = Array.from({ length: CHECKS_MAX + 10 }, (_, i) => ({
      item: `i${i}`,
      ok: true,
      note: "ok",
    }));
    const r = sealReport(evidence({ checks: many }), {});
    expect(r.checks.length).toBe(CHECKS_MAX);
    expect(r.flags).toContain("checks-truncated");
  });

  test("the sealed report is frozen — no verdict setter reaches it", () => {
    const r = sealReport(evidence(), {});
    expect(Object.isFrozen(r)).toBe(true);
    expect(() => {
      (r as unknown as Record<string, unknown>).verdict = "green";
    }).toThrow();
  });
});

describe("append-only persistence", () => {
  test("appends one record per line, last line authoritative", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rv-report-"));
    try {
      const first = sealReport(evidence({ reverifyId: "rv-1", checks: [] }), {});
      const second = sealReport(evidence({ reverifyId: "rv-2" }), {});
      appendReport(dir, first);
      appendReport(dir, second);

      const file = path.join(dir, "run-1.jsonl");
      const lines = fs.readFileSync(file, "utf8").trimEnd().split("\n");
      expect(lines.length).toBe(2);

      const all = readReports(dir, "run-1");
      expect(all.map((r) => r.reverifyId)).toEqual(["rv-1", "rv-2"]);
      expect(all.at(-1)!.verdict).toBe("green");
      expect(all[0]!.verdict).toBe("red");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("readReports on an absent run returns an empty list, not a throw", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rv-report-"));
    try {
      expect(readReports(dir, "no-such-run")).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
