/**
 * Unit tests for the eight Phase-0 exit-gate assertion modules that had none
 * (issue #F002). `p0-2-coms.ts` is covered in phase0-exit-gate.test.ts.
 *
 * Every test here targets ONE class of false green — the failure mode this gate
 * exists to catch, where "could not check" is reported as "passed":
 *
 *   - an empty collection standing in for a present one
 *   - a missing/undefined field coercing to a pass
 *   - a NaN or type-coerced numeric comparison
 *   - a regex that is inverted or accidentally permissive
 *   - a skip that the module reports as a pass
 *
 * `gate-runner.ts` guards the vacuous pass at the AGGREGATE level (an all-void
 * or empty gate is FAIL). Nothing guarded it per-assertion; these do.
 */
import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { onPath, preflightVerdict } from "../../src/gate/assertions/p0-1-env.ts";
import { auditMixedModelRun } from "../../src/gate/assertions/p0-3-mixed-model.ts";
import { auditLauncherGuards } from "../../src/gate/assertions/p0-4-guard.ts";
import { checkRequiredAcs, isOutcome } from "../../src/gate/assertions/lib/verdict.ts";
import { evaluatePiLensVerdict } from "../../src/gate/assertions/p0-5-pi-lens.ts";
import { evaluateLspVerdict } from "../../src/gate/assertions/p0-6-lsp.ts";
import {
  bridgeTestOk,
  extractServerId,
  extractToolNames,
  mcpBridgeAssertions,
  missingRequiredTools,
} from "../../src/gate/assertions/p0-7-mcp-bridge.ts";
import {
  describeListBanksFailure,
  evaluateRoundTrip,
} from "../../src/gate/assertions/p0-9-memory.ts";
import {
  auditContextJson,
  auditImpactJson,
  stalenessNote,
} from "../../src/gate/assertions/p0-10-gitnexus.ts";
import { buildAssertions } from "../../scripts/phase0-exit-gate.ts";
import {
  DEFAULT_ASSERTION_TIMEOUT_MS,
  GateAssertionSchema,
} from "../../src/gate/gate-runner.ts";
import { HindsightHttpError } from "../../src/hindsight/index.ts";
import type { RoundTripResult } from "../../src/hindsight/round-trip-verifier.ts";
import type { VerifierCheck, VerifierRun } from "../../src/gate/verifier-child.ts";

// ---------------------------------------------------------------------------
// P0.1 — preflight barrier
// ---------------------------------------------------------------------------

describe("p0-1 preflightVerdict — the barrier's own boundary", () => {
  test("a complete toolchain passes", () => {
    expect(preflightVerdict([], [], []).pass).toBe(true);
  });

  test("a missing binary fails and is named", () => {
    const v = preflightVerdict(["bun"], [], []);
    expect(v.pass).toBe(false);
    expect(v.detail).toContain("bun");
  });

  test("missing repo paths fail even when every binary is present", () => {
    // The two conditions are OR'd; a green binary list must not rescue a repo
    // the gate is not actually running inside.
    const v = preflightVerdict([], ["package.json"], []);
    expect(v.pass).toBe(false);
    expect(v.detail).toContain("package.json");
  });

  test("unset OPTIONAL env is reported but must NEVER move the verdict", () => {
    // Every one of these has a default. Failing on them would false-red a
    // perfectly provisioned host.
    const v = preflightVerdict([], [], ["HINDSIGHT_BASE_URL", "PI_LENS_ROOT"]);
    expect(v.pass).toBe(true);
    expect(v.detail).toContain("HINDSIGHT_BASE_URL");
  });

  test("the unset-env list is reported on the FAILING branch too (AC3)", () => {
    const v = preflightVerdict(["git"], [], ["QDS_REPO_SLUG"]);
    expect(v.pass).toBe(false);
    expect(v.detail).toContain("QDS_REPO_SLUG");
  });

  test("'none' is stated explicitly rather than leaving the env clause blank", () => {
    expect(preflightVerdict([], [], []).detail).toContain("none");
  });
});

describe("p0-1 onPath — X_OK is not proof of an executable", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "qds-onpath-"));
  const originalPath = process.env.PATH;

  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

  test("a real executable file on PATH is found", () => {
    const bin = path.join(tmp, "qds-fake-bin");
    fs.writeFileSync(bin, "#!/bin/sh\n", { mode: 0o755 });
    process.env.PATH = tmp;
    try {
      expect(onPath("qds-fake-bin")).toBe(true);
    } finally {
      process.env.PATH = originalPath;
    }
  });

  test("a DIRECTORY on PATH is not a binary — every directory carries X_OK", () => {
    // False green: `fs.accessSync(dir, X_OK)` succeeds on any directory, so a
    // directory named `git` would have satisfied "git is installed" and let
    // preflight green on a toolchain the gate cannot execute.
    fs.mkdirSync(path.join(tmp, "qds-fake-dir"), { recursive: true });
    process.env.PATH = tmp;
    try {
      expect(onPath("qds-fake-dir")).toBe(false);
    } finally {
      process.env.PATH = originalPath;
    }
  });

  test("an absent binary is not found", () => {
    process.env.PATH = tmp;
    try {
      expect(onPath("qds-definitely-not-installed")).toBe(false);
    } finally {
      process.env.PATH = originalPath;
    }
  });

  test("an empty PATH finds nothing rather than throwing", () => {
    process.env.PATH = "";
    try {
      expect(onPath("bun")).toBe(false);
    } finally {
      process.env.PATH = originalPath;
    }
  });
});

// ---------------------------------------------------------------------------
// P0.3 — clause 1, mixed-model merged JSON
// ---------------------------------------------------------------------------

const GOOD_RUN = {
  assertions: { exit_code: 0 },
  merged_output: {
    exitStatus: "success",
    partial: false,
    comsLog: [{}, {}],
    result: { models: ["gpt-oss-20b", "nemotron-nano-9b"] },
  },
};

describe("p0-3 auditMixedModelRun — clause 1", () => {
  test("a well-formed run of record passes with no failures", () => {
    const audit = auditMixedModelRun(GOOD_RUN);
    expect(audit.failures).toEqual([]);
    expect(audit.distinctModels).toBe(2);
    expect(audit.comsCount).toBe(2);
  });

  test("an EMPTY run object fails every clause element, never passes vacuously", () => {
    const audit = auditMixedModelRun({});
    expect(audit.failures.length).toBeGreaterThanOrEqual(4);
    expect(audit.distinctModels).toBe(0);
  });

  test("a missing exit_code is a failure — undefined must not read as 0", () => {
    const audit = auditMixedModelRun({ ...GOOD_RUN, assertions: {} });
    expect(audit.failures.some((f) => f.includes("exit_code"))).toBe(true);
  });

  test("a non-zero exit_code is a failure", () => {
    const audit = auditMixedModelRun({ ...GOOD_RUN, assertions: { exit_code: 3 } });
    expect(audit.failures.some((f) => f.includes("exit_code=3"))).toBe(true);
  });

  test("an EMPTY models array is 0 distinct models, not a pass", () => {
    const audit = auditMixedModelRun({
      ...GOOD_RUN,
      merged_output: { ...GOOD_RUN.merged_output, result: { models: [] } },
    });
    expect(audit.distinctModels).toBe(0);
    expect(audit.failures.some((f) => f.includes("distinct models=0"))).toBe(true);
  });

  test("two IDENTICAL models are one distinct model — the clause wants a MIXED run", () => {
    const audit = auditMixedModelRun({
      ...GOOD_RUN,
      merged_output: { ...GOOD_RUN.merged_output, result: { models: ["gpt-4", "gpt-4"] } },
    });
    expect(audit.distinctModels).toBe(1);
    expect(audit.failures.some((f) => f.includes("distinct models=1"))).toBe(true);
  });

  test("distinct OBJECT models are counted structurally, not collapsed by String()", () => {
    // String({}) is "[object Object]" for every object, which would report a
    // size of 1 for any object-shaped model list and false-red a real mixed run.
    const audit = auditMixedModelRun({
      ...GOOD_RUN,
      merged_output: {
        ...GOOD_RUN.merged_output,
        result: { models: [{ id: "a" }, { id: "b" }] },
      },
    });
    expect(audit.distinctModels).toBe(2);
    expect(audit.failures).toEqual([]);
  });

  test("a non-array `models` is named as a schema change, not silently zero", () => {
    const audit = auditMixedModelRun({
      ...GOOD_RUN,
      merged_output: { ...GOOD_RUN.merged_output, result: { models: "gpt-4,claude" } },
    });
    expect(audit.failures.some((f) => f.includes("not an array"))).toBe(true);
  });

  test("partial:true fails, and a MISSING partial fails too", () => {
    expect(
      auditMixedModelRun({
        ...GOOD_RUN,
        merged_output: { ...GOOD_RUN.merged_output, partial: true },
      }).failures.some((f) => f.includes("partial=true")),
    ).toBe(true);
    expect(
      auditMixedModelRun({
        ...GOOD_RUN,
        merged_output: { ...GOOD_RUN.merged_output, partial: undefined },
      }).failures.some((f) => f.includes("partial=undefined")),
    ).toBe(true);
  });

  test("exitStatus is matched exactly — 'SUCCESS' is not 'success'", () => {
    const audit = auditMixedModelRun({
      ...GOOD_RUN,
      merged_output: { ...GOOD_RUN.merged_output, exitStatus: "SUCCESS" },
    });
    expect(audit.failures.some((f) => f.includes("exitStatus=SUCCESS"))).toBe(true);
  });

  test("a STRING exit_code is not a numeric 0 — no type coercion on the decision path", () => {
    const audit = auditMixedModelRun({ ...GOOD_RUN, assertions: { exit_code: "0" as never } });
    expect(audit.failures.some((f) => f.includes("exit_code"))).toBe(true);
  });

  test("a null merged_output fails rather than throwing on property access", () => {
    const audit = auditMixedModelRun({ assertions: { exit_code: 0 }, merged_output: undefined });
    expect(audit.failures).toContain("no merged_output object");
  });

  test("a missing comsLog reads as 0 entries rather than throwing", () => {
    const audit = auditMixedModelRun({
      ...GOOD_RUN,
      merged_output: { ...GOOD_RUN.merged_output, comsLog: undefined },
    });
    expect(audit.comsCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// P0.4 — clause 3, launcher hard caps
// ---------------------------------------------------------------------------

const GOOD_MANIFEST = "team:\n  budgetCapUsd: 0.5\n  turnCap: 5\n  wallClockCapMs: 300000\n";
const GOOD_INDEX = "const TEAM_EXIT_CODES = {\n  success: 0,\n  overflow: 3,\n};\n";

describe("p0-4 auditLauncherGuards — clause 3 (budget-runaway guard, risk R10)", () => {
  test("real declarations and a non-zero overflow mapping pass", () => {
    const audit = auditLauncherGuards(GOOD_MANIFEST, GOOD_INDEX);
    expect(audit.failures).toEqual([]);
    expect(audit.overflowExit).toBe("3");
  });

  test("BUG: a COMMENTED-OUT cap is not a declared cap", () => {
    // Previously `/budgetCapUsd\s*:/` matched inside a YAML comment, so a
    // launcher whose caps had been commented out reported "budgetCapUsd +
    // wallClockCapMs declared" — the safety property retired, the gate green.
    const audit = auditLauncherGuards(
      "team:\n  # budgetCapUsd: 0.5\n  # wallClockCapMs: 300000\n",
      GOOD_INDEX,
    );
    expect(audit.failures).toContain("manifest declares no budgetCapUsd");
    expect(audit.failures).toContain("manifest declares no wallClockCapMs");
  });

  test("a key with no value is an absent cap wearing the key's name", () => {
    const audit = auditLauncherGuards("team:\n  budgetCapUsd:\n  wallClockCapMs: 300000\n", GOOD_INDEX);
    expect(audit.failures).toContain("manifest declares no budgetCapUsd");
  });

  test("a cap of 0 is not a cap", () => {
    const audit = auditLauncherGuards("team:\n  budgetCapUsd: 0\n  wallClockCapMs: 300000\n", GOOD_INDEX);
    expect(audit.failures).toContain("manifest declares no budgetCapUsd");
  });

  test("BUG: a stale `// overflow: 3` comment must not shadow a live `overflow: 0`", () => {
    // Previously `String.match` took the FIRST occurrence anywhere in the file,
    // comments included. A cap breach exiting 0 — the exact runaway clause 3
    // guards — was certified as correctly wired.
    const audit = auditLauncherGuards(
      GOOD_MANIFEST,
      "// legacy mapping was overflow: 3\nconst TEAM_EXIT_CODES = {\n  overflow: 0,\n};\n",
    );
    expect(audit.failures.some((f) => f.includes("must be non-zero"))).toBe(true);
  });

  test("a bare `overflow: 0` mapping fails", () => {
    const audit = auditLauncherGuards(GOOD_MANIFEST, "const m = {\n  overflow: 0,\n};\n");
    expect(audit.failures.some((f) => f.includes("overflow maps to exit 0"))).toBe(true);
  });

  test("no overflow mapping at all is a failure, not an absence of evidence", () => {
    const audit = auditLauncherGuards(GOOD_MANIFEST, "const m = { success: 0 };\n");
    expect(audit.failures.some((f) => f.includes("no overflow exit-code mapping"))).toBe(true);
    expect(audit.overflowExit).toBeUndefined();
  });

  test("an overflow mapping that exists ONLY in a comment is no mapping", () => {
    const audit = auditLauncherGuards(GOOD_MANIFEST, "// overflow: 3 (planned)\nconst m = {};\n");
    expect(audit.failures.some((f) => f.includes("no overflow exit-code mapping"))).toBe(true);
  });

  test("a fractional budget cap is accepted — 0.5 must not read as absent", () => {
    expect(auditLauncherGuards(GOOD_MANIFEST, GOOD_INDEX).failures).toEqual([]);
  });

  test("a negative cap is not a cap", () => {
    const audit = auditLauncherGuards("team:\n  budgetCapUsd: -1\n  wallClockCapMs: 300000\n", GOOD_INDEX);
    expect(audit.failures).toContain("manifest declares no budgetCapUsd");
  });

  test("a DIFFERENT key ending in the cap's name does not satisfy it", () => {
    // The permissive-substring class: an unanchored /budgetCapUsd\s*:/ is happy
    // with `defaultBudgetCapUsd`, a key the launcher never reads.
    const audit = auditLauncherGuards(
      "team:\n  defaultBudgetCapUsd: 0.5\n  wallClockCapMs: 300000\n",
      GOOD_INDEX,
    );
    expect(audit.failures).toContain("manifest declares no budgetCapUsd");
  });

  test("the real repo artifacts pass — the tightened checks must not false-red", () => {
    const root = path.join(import.meta.dir, "..", "..");
    const audit = auditLauncherGuards(
      fs.readFileSync(path.join(root, "cli-anything", "manifests", "research-trio.yaml"), "utf8"),
      fs.readFileSync(path.join(root, "cli-anything", "src", "index.ts"), "utf8"),
    );
    expect(audit.failures).toEqual([]);
    expect(Number(audit.overflowExit)).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// P0.5 / P0.6 — verifier-backed clauses
// ---------------------------------------------------------------------------

function verdictRun(results: VerifierCheck[], over: Partial<VerifierRun> = {}): VerifierRun {
  return {
    exitCode: 0,
    verdict: { results },
    stdout: JSON.stringify({ results }),
    stderrTail: "",
    ...over,
  };
}

const AC3_GREEN: VerifierCheck = {
  ac: "AC3",
  name: "warning-count readable",
  status: "pass",
  evidence: { warningCount: 7 },
};

describe("checkRequiredAcs — the shared shell p0-5 and p0-6 both build on", () => {
  test("an unusable run short-circuits to a skip outcome, not a failures list", () => {
    const result = checkRequiredAcs({ exitCode: 2, stdout: "", stderrTail: "boom" }, ["AC1"]);
    expect(isOutcome(result)).toBe(true);
    if (isOutcome(result)) {
      expect(result.pass).toBe(false);
      expect(result.skip).toBe(true);
    }
  });

  test("a missing AC is named in failures and its check is undefined", () => {
    const result = checkRequiredAcs(verdictRun([]), ["AC1"]);
    expect(isOutcome(result)).toBe(false);
    if (!isOutcome(result)) {
      expect(result.failures).toEqual(["no AC1 check in verdict"]);
      expect(result.checks.AC1).toBeUndefined();
    }
  });

  test("a present but non-passing AC fails and carries its reason", () => {
    const result = checkRequiredAcs(
      verdictRun([{ ac: "AC1", name: "x", status: "fail", reason: "broke" }]),
      ["AC1"],
    );
    if (!isOutcome(result)) {
      expect(result.failures).toEqual(["AC1 status=fail: broke"]);
    }
  });

  test("every requested AC present and green yields no failures and populated checks", () => {
    const result = checkRequiredAcs(verdictRun([AC3_GREEN]), ["AC3"]);
    if (!isOutcome(result)) {
      expect(result.failures).toEqual([]);
      expect(result.checks.AC3).toBe(AC3_GREEN);
    }
  });
});

describe("p0-5 evaluatePiLensVerdict — clause 4, second branch", () => {
  test("a healthy AC3 with a numeric count passes", () => {
    const out = evaluatePiLensVerdict(verdictRun([AC3_GREEN]));
    expect(out.pass).toBe(true);
    expect(out.skip).toBeUndefined();
    expect(out.detail).toContain("warningCount=7");
  });

  test("a SKIP is emitted as a skip, never as a pass", () => {
    // gate-runner records skip separately and still fails the gate; a module
    // that returned {pass:true} here would launder "could not check" into green.
    const out = evaluatePiLensVerdict({
      exitCode: null,
      stdout: "",
      stderrTail: "",
      spawnError: "bun: not found",
    });
    expect(out.pass).toBe(false);
    expect(out.skip).toBe(true);
  });

  test("exit 2 (fatal before any check ran) is a skip, not a silent pass", () => {
    const out = evaluatePiLensVerdict({
      exitCode: 2,
      stdout: "",
      stderrTail: "pi-lens could not be resolved",
      verdict: { results: [] },
    });
    expect(out.skip).toBe(true);
    expect(out.detail).toContain("exited 2");
  });

  test("an EMPTY results array is a fail — no AC3 was ever produced", () => {
    const out = evaluatePiLensVerdict(verdictRun([]));
    expect(out.pass).toBe(false);
    expect(out.detail).toContain("no AC3");
  });

  test("a failing AC3 fails and carries the verifier's reason", () => {
    const out = evaluatePiLensVerdict(
      verdictRun([{ ac: "AC3", name: "x", status: "fail", reason: "no artifact on disk" }]),
    );
    expect(out.pass).toBe(false);
    expect(out.detail).toContain("no artifact on disk");
  });

  test("a SKIPPED AC3 is not a passing AC3", () => {
    const out = evaluatePiLensVerdict(verdictRun([{ ac: "AC3", name: "x", status: "skip" }]));
    expect(out.pass).toBe(false);
    expect(out.detail).toContain("status=skip");
  });

  test("BUG: a green AC3 carrying NO evidence must not certify clause 4", () => {
    // Previously this returned pass:true with a detail asserting the proxy had
    // been "read headless with an explicit fallbackReason" — while the code had
    // inspected nothing but `status === "pass"`.
    const out = evaluatePiLensVerdict(verdictRun([{ ac: "AC3", name: "x", status: "pass" }]));
    expect(out.pass).toBe(false);
    expect(out.detail).toContain("warningCount");
  });

  test("BUG: a green AC3 whose warningCount is not a number must not pass", () => {
    const out = evaluatePiLensVerdict(
      verdictRun([{ ...AC3_GREEN, evidence: { warningCount: "7" } }]),
    );
    expect(out.pass).toBe(false);
  });

  test("a NaN warning count fails rather than satisfying the read", () => {
    const out = evaluatePiLensVerdict(
      verdictRun([{ ...AC3_GREEN, evidence: { warningCount: Number.NaN } }]),
    );
    expect(out.pass).toBe(false);
  });

  test("ZERO warnings is a legitimate readable count, not an absent one", () => {
    const out = evaluatePiLensVerdict(
      verdictRun([{ ...AC3_GREEN, evidence: { warningCount: 0 } }]),
    );
    expect(out.pass).toBe(true);
    expect(out.detail).toContain("warningCount=0");
  });

  test("a verdict with NO results array at all is a skip, not a pass", () => {
    const out = evaluatePiLensVerdict({
      exitCode: 0,
      verdict: { summary: { total: 0 } },
      stdout: "{}",
      stderrTail: "",
    });
    expect(out.pass).toBe(false);
    expect(out.skip).toBe(true);
  });

  test("the detail states which path was taken instead of always claiming a fallback", () => {
    const primary = evaluatePiLensVerdict(verdictRun([AC3_GREEN]));
    expect(primary.detail).toContain("no fallback was needed");

    const fellBack = evaluatePiLensVerdict(
      verdictRun([
        { ...AC3_GREEN, evidence: { warningCount: 2, fallbackReason: "jsonl absent" } },
      ]),
    );
    expect(fellBack.detail).toContain("§9.3 fallback path");
    expect(fellBack.detail).toContain("jsonl absent");
  });
});

const LSP_AC1: VerifierCheck = {
  ac: "AC1",
  name: "diagnostics",
  status: "pass",
  evidence: { editUncommitted: true, warmP95Met: true, warmP95Ms: 800, warmP95BudgetMs: 1500 },
};
const LSP_AC2: VerifierCheck = { ac: "AC2", name: "navigation", status: "pass" };

describe("p0-6 evaluateLspVerdict — clause 4b", () => {
  test("AC1 + AC2 green with the required evidence passes", () => {
    const out = evaluateLspVerdict(verdictRun([LSP_AC1, LSP_AC2]));
    expect(out.pass).toBe(true);
    expect(out.detail).toContain("warmP95Ms=800");
  });

  test("an EMPTY results array fails both ACs rather than passing vacuously", () => {
    const out = evaluateLspVerdict(verdictRun([]));
    expect(out.pass).toBe(false);
    expect(out.detail).toContain("no AC1");
    expect(out.detail).toContain("no AC2");
  });

  test("an unparseable verdict is a skip, never a pass", () => {
    const out = evaluateLspVerdict({
      exitCode: 0,
      stdout: "not json",
      stderrTail: "",
      parseError: "Unexpected token",
    });
    expect(out.pass).toBe(false);
    expect(out.skip).toBe(true);
  });

  test("AC2 present but failing fails the clause", () => {
    const out = evaluateLspVerdict(
      verdictRun([LSP_AC1, { ac: "AC2", name: "navigation", status: "fail", reason: "no def" }]),
    );
    expect(out.pass).toBe(false);
    expect(out.detail).toContain("no def");
  });

  test("a green AC1 with a MISSING editUncommitted does not prove the clause", () => {
    // The clause is about diagnostics reflecting an UNCOMMITTED edit; a green
    // check alone would let a committed-file run stand in for it.
    const out = evaluateLspVerdict(
      verdictRun([{ ...LSP_AC1, evidence: { warmP95Met: true } }, LSP_AC2]),
    );
    expect(out.pass).toBe(false);
    expect(out.detail).toContain("editUncommitted=undefined");
  });

  test("editUncommitted must be a literal true — a truthy string is not proof", () => {
    const out = evaluateLspVerdict(
      verdictRun([
        { ...LSP_AC1, evidence: { editUncommitted: "true", warmP95Met: true } },
        LSP_AC2,
      ]),
    );
    expect(out.pass).toBe(false);
  });

  test("a missed latency budget fails even when AC1 itself is green", () => {
    const out = evaluateLspVerdict(
      verdictRun([
        { ...LSP_AC1, evidence: { editUncommitted: true, warmP95Met: false } },
        LSP_AC2,
      ]),
    );
    expect(out.pass).toBe(false);
    expect(out.detail).toContain("latency budget not met");
  });

  test("a green AC1 with NO evidence object at all fails both evidence keys", () => {
    const out = evaluateLspVerdict(
      verdictRun([{ ac: "AC1", name: "diagnostics", status: "pass" }, LSP_AC2]),
    );
    expect(out.pass).toBe(false);
    expect(out.detail).toContain("editUncommitted=undefined");
    expect(out.detail).toContain("warmP95Met=undefined");
  });

  test("a MISSING warmP95Met is as disqualifying as a false one", () => {
    const out = evaluateLspVerdict(
      verdictRun([{ ...LSP_AC1, evidence: { editUncommitted: true } }, LSP_AC2]),
    );
    expect(out.pass).toBe(false);
    expect(out.detail).toContain("warmP95Met=undefined");
  });

  test("the green detail carries the scoping caveat, not a bare 'LSP proven'", () => {
    expect(evaluateLspVerdict(verdictRun([LSP_AC1, LSP_AC2])).detail).toContain("SCOPED");
  });
});

// ---------------------------------------------------------------------------
// P0.7 — clause 6, SwarmClaw <-> Hindsight MCP bridge
// ---------------------------------------------------------------------------

const ALL_TOOLS = ["retain", "recall", "reflect", "consolidate"];

describe("p0-7 missingRequiredTools — 'could not see the toolset' is never a pass", () => {
  test("the full toolset leaves nothing missing", () => {
    expect(missingRequiredTools({ tools: ALL_TOOLS })).toEqual([]);
  });

  test("an EMPTY tools array is a FAIL, not a vacuous pass", () => {
    expect(missingRequiredTools({ tools: [] })).toEqual(ALL_TOOLS);
  });

  test("a MISSING tools key is a FAIL, not a skip", () => {
    expect(missingRequiredTools({})).toEqual(ALL_TOOLS);
  });

  test("an undefined body reports everything missing", () => {
    expect(missingRequiredTools(undefined)).toEqual(ALL_TOOLS);
  });

  test("a non-array `tools` is a shape change, reported as everything missing", () => {
    expect(missingRequiredTools({ tools: "retain,recall" })).toEqual(ALL_TOOLS);
    expect(missingRequiredTools({ tools: { retain: true } })).toEqual(ALL_TOOLS);
  });

  test("a partial toolset names exactly what is absent", () => {
    expect(missingRequiredTools({ tools: ["retain", "recall"] })).toEqual(["reflect", "consolidate"]);
  });
});

describe("p0-7 extractToolNames — unrecognised entries are dropped, never coerced", () => {
  test("object entries are read by name", () => {
    expect(extractToolNames({ tools: [{ name: "retain" }, "recall"] })).toEqual(["retain", "recall"]);
  });

  test("a non-string name is dropped rather than standing in for a tool", () => {
    // `filter(Boolean)` over `t?.name` used to keep a truthy non-string here.
    expect(extractToolNames({ tools: [{ name: 42 }, { name: "recall" }] })).toEqual(["recall"]);
  });

  test("null, empty-string and shapeless entries are dropped", () => {
    expect(extractToolNames({ tools: [null, "", {}, "retain"] })).toEqual(["retain"]);
  });

  test("a non-object body yields no tools rather than throwing", () => {
    expect(extractToolNames("retain")).toEqual([]);
    expect(extractToolNames(null)).toEqual([]);
  });
});

describe("p0-7 bridgeTestOk / extractServerId", () => {
  test("ok must be a literal true", () => {
    expect(bridgeTestOk({ ok: true })).toBe(true);
    expect(bridgeTestOk({ ok: "true" })).toBe(false);
    expect(bridgeTestOk({ ok: 1 })).toBe(false);
  });

  test("a missing ok is not health", () => {
    expect(bridgeTestOk({})).toBe(false);
    expect(bridgeTestOk(undefined)).toBe(false);
  });

  test("a registration id must be a non-empty string", () => {
    expect(extractServerId({ id: "srv-1" })).toBe("srv-1");
    expect(extractServerId({ id: "" })).toBeUndefined();
    expect(extractServerId({ id: 7 })).toBeUndefined();
    expect(extractServerId({})).toBeUndefined();
    expect(extractServerId(undefined)).toBeUndefined();
  });
});

// F069: the probe used to register one MCP server per run against a 32-slot
// cap with no way to reclaim it — the mitigation was a comment telling the
// operator to point the gate at a disposable instance. It now DELETEs what it
// registered, on every exit path, so a shared instance survives repeated runs.
describe("p0-7 probe reclaim — the registered server is deleted in a finally", () => {
  /** Minimal SwarmClaw stand-in: records every request, answers the four routes. */
  function fakeSwarmClaw(opts: { testStatus?: number; testBody?: unknown } = {}) {
    const seen: Array<{ method: string; path: string }> = [];
    const srv = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const p = new URL(req.url).pathname;
        seen.push({ method: req.method, path: p });
        if (req.method === "POST" && p === "/api/agents") {
          return Response.json({ agentId: "probe" }, { status: 201 });
        }
        if (req.method === "POST" && p === "/api/mcp-servers") {
          return Response.json({ id: "srv-probe-1" }, { status: 201 });
        }
        if (req.method === "POST" && p.endsWith("/test")) {
          return Response.json(
            opts.testBody ?? { ok: true, tools: ALL_TOOLS },
            { status: opts.testStatus ?? 200 },
          );
        }
        if (req.method === "DELETE" && p === "/api/mcp-servers/srv-probe-1") {
          return Response.json({ ok: true, id: "srv-probe-1" }, { status: 200 });
        }
        return Response.json({ error: "not found" }, { status: 404 });
      },
    });
    return { seen, url: `http://127.0.0.1:${srv.port}`, stop: () => srv.stop(true) };
  }

  const bridgeCheck = () => mcpBridgeAssertions()[0]!.check;

  async function withFake(
    fake: ReturnType<typeof fakeSwarmClaw>,
    fn: () => Promise<void>,
  ): Promise<void> {
    const prev = process.env.SWARMCLAW_BASE_URL;
    process.env.SWARMCLAW_BASE_URL = fake.url;
    try {
      await fn();
    } finally {
      if (prev === undefined) {
        // biome-ignore lint/performance/noDelete: unsetting env vars requires delete
        delete process.env.SWARMCLAW_BASE_URL;
      } else {
        process.env.SWARMCLAW_BASE_URL = prev;
      }
      await fake.stop();
    }
  }

  test("a PASSING run deletes the server it registered", async () => {
    const fake = fakeSwarmClaw();
    await withFake(fake, async () => {
      const result = await bridgeCheck()();
      expect(result.pass).toBeTrue();
      expect(fake.seen).toContainEqual({ method: "DELETE", path: "/api/mcp-servers/srv-probe-1" });
    });
  });

  test("a FAILING /test still deletes it — the reclaim is in a finally, not on the happy path", async () => {
    const fake = fakeSwarmClaw({ testStatus: 502, testBody: { ok: false, error: "transport is not running" } });
    await withFake(fake, async () => {
      const result = await bridgeCheck()();
      expect(result.pass).toBeFalse();
      expect(fake.seen).toContainEqual({ method: "DELETE", path: "/api/mcp-servers/srv-probe-1" });
    });
  });
});

// ---------------------------------------------------------------------------
// P0.9 — clause 7, Hindsight round trip
// ---------------------------------------------------------------------------

const OK_ROUND_TRIP: RoundTripResult = {
  ok: true,
  memoryId: "m-1",
  recallMatches: true,
  insightCount: 2,
  consolidatedCount: 1,
  preservedCount: 1,
  durations: { retain: 1, recall: 1, serverRecall: 1, reflect: 1, consolidate: 1, postRecall: 1, total: 5 },
  slowQuery: false,
  requestId: "r-1",
};

describe("p0-9 evaluateRoundTrip — clause 7", () => {
  test("a complete round trip passes and names the bank", () => {
    const out = evaluateRoundTrip(OK_ROUND_TRIP, "qds-factory");
    expect(out.pass).toBe(true);
    expect(out.detail).toContain("qds-factory");
  });

  test("a failed round trip names the step that broke", () => {
    const out = evaluateRoundTrip(
      {
        ok: false,
        step: "recall",
        error: { code: "empty_recall", message: "recall returned no results" },
        requestId: "r-2",
      },
      "qds-factory",
    );
    expect(out.pass).toBe(false);
    expect(out.detail).toContain("recall");
    expect(out.detail).toContain("empty_recall");
  });

  test("ok:true with recallMatches:false does NOT certify a round trip", () => {
    // The gate printed recallMatches in its green detail while deciding on
    // `result.ok` alone — reporting a value is not checking it.
    const out = evaluateRoundTrip({ ...OK_ROUND_TRIP, recallMatches: false }, "b");
    expect(out.pass).toBe(false);
    expect(out.detail).toContain("recallMatches=false");
  });

  test("ok:true with ZERO insights does not satisfy 'reflect'", () => {
    const out = evaluateRoundTrip({ ...OK_ROUND_TRIP, insightCount: 0 }, "b");
    expect(out.pass).toBe(false);
    expect(out.detail).toContain("insightCount=0");
  });

  test("a NaN insight count fails the threshold rather than satisfying it", () => {
    // NaN >= 1 is false, so this must fail — the p0-2 `meetsMinCount` lesson.
    const out = evaluateRoundTrip({ ...OK_ROUND_TRIP, insightCount: Number.NaN }, "b");
    expect(out.pass).toBe(false);
  });
});

describe("p0-9 describeListBanksFailure", () => {
  test("an unrelated service on the shared port is NAMED, not dumped as markup", () => {
    const err = new HindsightHttpError(
      404,
      "<html>\n <head><title>Jupyter Server</title></head>\n <body>not found</body>\n</html>",
      "req-1",
    );
    const detail = describeListBanksFailure(err, "http://127.0.0.1:8888");
    expect(detail).toContain('served by "Jupyter Server"');
    expect(detail).not.toContain("<body>");
  });

  test("a non-HTML HTTP failure keeps its body", () => {
    const detail = describeListBanksFailure(
      new HindsightHttpError(503, "upstream unavailable", "req-2"),
      "http://h",
    );
    expect(detail).toContain("HTTP 503");
    expect(detail).toContain("upstream unavailable");
  });

  test("a transport error reads as unreachable and still cites OQ-4", () => {
    const detail = describeListBanksFailure(new Error("ECONNREFUSED"), "http://h");
    expect(detail).toContain("unreachable");
    expect(detail).toContain("OQ-4");
  });

  test("a non-Error throw is still rendered legibly", () => {
    expect(describeListBanksFailure("boom", "http://h")).toContain("boom");
  });
});

// ---------------------------------------------------------------------------
// P0.10 — clause 7b, gitnexus graph queries
// ---------------------------------------------------------------------------

describe("p0-10 auditContextJson — clause 7b", () => {
  test("a resolved symbol passes and yields its filePath", () => {
    const audit = auditContextJson({ status: "found", symbol: { filePath: "src/a.ts" } });
    expect(audit.pass).toBe(true);
    expect(audit.filePath).toBe("src/a.ts");
  });

  test("a soft error with exit 0 is a FAIL — the CLI reports failures in-band", () => {
    const audit = auditContextJson({ status: "found", error: "index missing" });
    expect(audit.pass).toBe(false);
    expect(audit.detail).toContain("index missing");
  });

  test("status=found with NO symbol is not real graph data", () => {
    const audit = auditContextJson({ status: "found" });
    expect(audit.pass).toBe(false);
  });

  test("an EMPTY filePath is not a resolved symbol", () => {
    const audit = auditContextJson({ status: "found", symbol: { filePath: "" } });
    expect(audit.pass).toBe(false);
  });

  test("a not-found status fails and is reported verbatim", () => {
    expect(auditContextJson({ status: "not_found" }).detail).toContain("not_found");
  });

  test("a MISSING status fails rather than reading as found", () => {
    expect(auditContextJson({ symbol: { filePath: "src/a.ts" } }).pass).toBe(false);
  });

  test("a shape change is a named failure, not a silent undefined", () => {
    // The #F028 mechanism: with `any`, `json.symbol?.filePath` on a renamed
    // field just evaluates to undefined somewhere downstream.
    const audit = auditContextJson({ status: 200, symbol: { filePath: "src/a.ts" } });
    expect(audit.pass).toBe(false);
    expect(audit.detail).toContain("unrecognised shape");
  });

  test("a non-object payload fails", () => {
    expect(auditContextJson(null).pass).toBe(false);
    expect(auditContextJson("found").pass).toBe(false);
    expect(auditContextJson([]).pass).toBe(false);
  });
});

describe("p0-10 auditImpactJson", () => {
  test("a target with a name passes and carries the impacted count", () => {
    const audit = auditImpactJson({ target: { name: "createServer" }, impactedCount: 12 });
    expect(audit.pass).toBe(true);
    expect(audit.impactedCount).toBe(12);
  });

  test("an impactedCount of 0 is real data, not an absence", () => {
    expect(auditImpactJson({ target: { name: "x" }, impactedCount: 0 }).pass).toBe(true);
  });

  test("no target means graph data absent", () => {
    expect(auditImpactJson({ impactedCount: 12 }).pass).toBe(false);
  });

  test("a target with an EMPTY name is not a target", () => {
    expect(auditImpactJson({ target: { name: "" } }).pass).toBe(false);
  });

  test("a scalar `target` is a shape change, named rather than silently undefined", () => {
    const audit = auditImpactJson({ target: "createServer" });
    expect(audit.pass).toBe(false);
    expect(audit.detail).toContain("unrecognised shape");
  });

  test("an in-band error fails even with a target present", () => {
    const audit = auditImpactJson({ error: "graph not built", target: { name: "x" } });
    expect(audit.pass).toBe(false);
    expect(audit.detail).toContain("graph not built");
  });
});

describe("p0-10 stalenessNote — the signal must not fire on every healthy run", () => {
  test("a genuinely stale index warns", () => {
    expect(stalenessNote({ status: 0, stdout: "Index is stale (12 files changed)", stderr: "" })).toContain(
      "STALE",
    );
  });

  test("BUG: 'stale: false' is a FRESH index and must not warn", () => {
    // A bare /stale/i matched the word inside its own negation. A staleness
    // warning that fires on every healthy run is a warning nobody reads.
    expect(stalenessNote({ status: 0, stdout: "stale: false\nsymbols: 3912", stderr: "" })).toBe("");
  });

  test("'not stale' must not warn either", () => {
    expect(stalenessNote({ status: 0, stdout: "Index is not stale.", stderr: "" })).toBe("");
  });

  test("a fresh index emits nothing", () => {
    expect(stalenessNote({ status: 0, stdout: "Index fresh. 3912 symbols.", stderr: "" })).toBe("");
  });

  test("a FAILED status command reports UNKNOWN — it must never read as fresh", () => {
    const note = stalenessNote({ status: 1, stdout: "", stderr: "no index" });
    expect(note).toContain("UNKNOWN");
    expect(note).toContain("no index");
  });

  test("a status command that could not be spawned also reports UNKNOWN", () => {
    expect(stalenessNote({ status: null, stdout: "", stderr: "ENOENT" })).toContain("UNKNOWN");
  });

  test("exit 0 with EMPTY stdout is UNKNOWN, not fresh", () => {
    // Empty output misses every pattern. Silence would read as a clean index.
    expect(stalenessNote({ status: 0, stdout: "   \n", stderr: "" })).toContain("UNKNOWN");
  });
});

/**
 * F068 — the assertion ARRAY, not the predicates.
 *
 * Every predicate above is unit-tested; the array they are assembled into was
 * not, and `buildAssertions()` is where the two things that can only go wrong
 * at assembly time are checked: the per-assertion schema parse and the
 * duplicate-id scan. Both threw only in production, so a mistyped `group`, a
 * duplicated id or a slow check left on the 30 s default surfaced as an exit-2
 * crash partway through a real Phase-0 gate run — after the earlier assertions
 * had already spent their minutes.
 *
 * `buildAssertions()` only CONSTRUCTS descriptors (each `run` is a closure it
 * never invokes), so this costs nothing and spawns nothing.
 */
describe("buildAssertions — the assembled Phase-0 array (F068)", () => {
  // NOT called in the describe body: buildAssertions() THROWS on a bad schema
  // or a duplicate id, and a throw there aborts collection for the whole file
  // instead of failing these tests — the two tests written to name that exact
  // fault would never get to report it.
  test("building the array does not throw — the schema and duplicate-id checks pass", () => {
    expect(() => buildAssertions()).not.toThrow();
  });

  test("the array is non-empty — an empty gate is a vacuous pass", () => {
    expect(buildAssertions().length).toBeGreaterThan(0);
  });

  test("every assertion schema-validates", () => {
    const bad = buildAssertions()
      .map((a) => ({ id: a.id, parsed: GateAssertionSchema.safeParse(a) }))
      .filter((r) => !r.parsed.success)
      .map((r) => r.id);
    expect(bad).toEqual([]);
  });

  test("ids are unique — a duplicate silently shadows a clause in the report", () => {
    const ids = buildAssertions().map((a) => a.id);
    expect(ids.length).toBe(new Set(ids).size);
  });

  test("the known-slow assertions declare a timeout_ms above the 30s default", () => {
    // P0.6 (warm LSP: server start + diagnostics), P0.7 (three HTTP probes
    // against the MCP bridge) and P0.9 (Hindsight retain->recall->reflect) all
    // routinely run past DEFAULT_ASSERTION_TIMEOUT_MS. An override dropped here
    // does not fail the build — it fails the assertion, as a timeout, which
    // reads as a real regression in the thing under test.
    const assertions = buildAssertions();
    for (const prefix of ["P0.6", "P0.7", "P0.9"]) {
      const a = assertions.find((x) => x.id.startsWith(`${prefix}-`));
      expect(a, `no assertion with id prefix ${prefix}-`).toBeDefined();
      expect(a?.timeout_ms ?? 0).toBeGreaterThan(DEFAULT_ASSERTION_TIMEOUT_MS);
    }
  });
});
