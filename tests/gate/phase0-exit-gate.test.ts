/**
 * Tests for the Phase-0 exit gate (Story P0.11).
 *
 * Three layers:
 *  1. Unit tests over the gate runner's orchestration semantics — fail-fast,
 *     per-assertion timeout, bounded parallelism, and the PASS/FAIL rule.
 *     These are pure and run everywhere, with no Phase-0 infrastructure.
 *  2. Schema tests pinning GateAssertionSchema / GateReportSchema.
 *  3. An integration test that spawns `bun scripts/phase0-exit-gate.ts` and
 *     asserts the process contract (stdout marker, exit code, report file).
 *     This asserts the CONTRACT, not a green Phase-0 — a red gate on an
 *     unprovisioned host is a correct outcome, so the test accepts either
 *     verdict and only fails if the contract itself is violated.
 */
import { describe, expect, test } from "bun:test";
import { execFile, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
import {
  GateAssertionSchema,
  GateReportSchema,
  runGate,
  type GateAssertion,
} from "../../src/gate/gate-runner.ts";
import { asCount, auditOqDecisions, meetsMinCount } from "../../src/gate/assertions/p0-2-coms.ts";

const REPO_ROOT = path.join(import.meta.dir, "..", "..");
const GATE = path.join(REPO_ROOT, "scripts", "phase0-exit-gate.ts");

/** Minimal assertion factory — keeps each test's intent legible. */
function assertion(
  id: string,
  check: GateAssertion["check"],
  over: Partial<GateAssertion> = {},
): GateAssertion {
  return {
    id,
    story: "P0.x",
    prd_clause: "§13 P0 clause x",
    description: `test assertion ${id}`,
    group: "main",
    check,
    ...over,
  };
}

const ok = async () => ({ pass: true as const });
const bad = async () => ({ pass: false as const, detail: "deliberately red" });

describe("runGate — PASS/FAIL rule", () => {
  test("all-green yields overall PASS", async () => {
    const report = await runGate([assertion("a", ok), assertion("b", ok)]);
    expect(report.overall).toBe("PASS");
    expect(report.assertions.every((a) => a.status === "pass")).toBe(true);
  });

  test("a single red yields overall FAIL and preserves the other results", async () => {
    const report = await runGate([assertion("a", ok), assertion("b", bad)]);
    expect(report.overall).toBe("FAIL");
    expect(report.assertions.find((a) => a.id === "a")?.status).toBe("pass");
    expect(report.assertions.find((a) => a.id === "b")?.status).toBe("fail");
  });

  test("failure detail is carried through, not flattened to a generic message", async () => {
    const report = await runGate([
      assertion("b", async () => ({ pass: false as const, detail: "swarmclaw 8080 refused" })),
    ]);
    expect(report.assertions[0]?.detail).toBe("swarmclaw 8080 refused");
  });

  test("a SKIP is not a pass — an unproven assertion fails the gate", async () => {
    // A binary exit gate must never let "could not check" masquerade as green.
    const report = await runGate([
      assertion("a", ok),
      assertion("s", async () => ({ pass: false as const, skip: true, detail: "pi-lens absent" })),
    ]);
    expect(report.assertions.find((a) => a.id === "s")?.status).toBe("skip");
    expect(report.overall).toBe("FAIL");
  });

  test("a VOID clause is recorded for traceability but does not affect the verdict", async () => {
    // Clauses whose predecessor story was killed are neither pass nor fail.
    const report = await runGate([
      assertion("a", ok),
      assertion("v", ok, { void_reason: "P0.1 killed by Warren decision" }),
    ]);
    const v = report.assertions.find((a) => a.id === "v");
    expect(v?.status).toBe("void");
    expect(v?.detail).toContain("Warren");
    expect(report.overall).toBe("PASS");
  });

  test("a void assertion's check is never invoked", async () => {
    let called = false;
    const report = await runGate([
      assertion("a", ok),
      assertion("v", async () => {
        called = true;
        return { pass: true as const };
      }, { void_reason: "killed" }),
    ]);
    expect(called).toBe(false);
    // Paired with a live green assertion so this test isolates "check not
    // invoked" rather than re-testing the all-void FAIL rule above.
    expect(report.overall).toBe("PASS");
  });

  test("an empty assertion list is FAIL, not a vacuous PASS", async () => {
    const report = await runGate([]);
    expect(report.overall).toBe("FAIL");
  });

  test("a gate of only void clauses is FAIL — nothing was actually proven", async () => {
    const report = await runGate([assertion("v", ok, { void_reason: "killed" })]);
    expect(report.overall).toBe("FAIL");
  });
});

describe("runGate — throwing checks", () => {
  test("a check that throws becomes a red assertion, not a crashed gate", async () => {
    const report = await runGate([
      assertion("boom", async () => {
        throw new Error("connection reset");
      }),
    ]);
    expect(report.overall).toBe("FAIL");
    expect(report.assertions[0]?.status).toBe("fail");
    expect(report.assertions[0]?.detail).toContain("connection reset");
  });

  test("a non-Error throw is still reported legibly", async () => {
    const report = await runGate([
      assertion("boom", async () => {
        throw "plain string";
      }),
    ]);
    expect(report.assertions[0]?.detail).toContain("plain string");
  });
});

describe("runGate — per-assertion timeout", () => {
  test("a hanging check is cut off and reported, never hangs the gate", async () => {
    const report = await runGate(
      [assertion("hang", () => new Promise(() => {}))],
      { assertionTimeoutMs: 50 },
    );
    expect(report.overall).toBe("FAIL");
    expect(report.assertions[0]?.status).toBe("fail");
    expect(report.assertions[0]?.detail).toMatch(/timeout|timed out/i);
  });

  test("the timeout is per-assertion, so a fast check still records its own result", async () => {
    const report = await runGate(
      [assertion("hang", () => new Promise(() => {})), assertion("fast", ok)],
      { assertionTimeoutMs: 50 },
    );
    expect(report.assertions.find((a) => a.id === "fast")?.status).toBe("pass");
  });

  test("a timed-out assertion reports a duration at or above its budget", async () => {
    const report = await runGate(
      [assertion("hang", () => new Promise(() => {}))],
      { assertionTimeoutMs: 50 },
    );
    expect(report.assertions[0]?.duration_ms).toBeGreaterThanOrEqual(50);
  });
});

describe("runGate — fail-fast preflight", () => {
  test("a red preflight skips every downstream assertion", async () => {
    let downstreamRan = false;
    const report = await runGate([
      assertion("env", bad, { group: "preflight" }),
      assertion("later", async () => {
        downstreamRan = true;
        return { pass: true as const };
      }),
    ]);
    expect(downstreamRan).toBe(false);
    expect(report.overall).toBe("FAIL");
    const later = report.assertions.find((a) => a.id === "later");
    expect(later?.status).toBe("skip");
    expect(later?.detail).toMatch(/preflight/i);
  });

  test("every downstream assertion is still listed after a preflight abort", async () => {
    // AC3 wants the failing env vars reported, not a truncated report.
    const report = await runGate([
      assertion("env", bad, { group: "preflight" }),
      assertion("x", ok),
      assertion("y", ok),
    ]);
    expect(report.assertions.map((a) => a.id)).toEqual(["env", "x", "y"]);
  });

  test("a green preflight lets downstream assertions run", async () => {
    const report = await runGate([assertion("env", ok, { group: "preflight" }), assertion("x", ok)]);
    expect(report.overall).toBe("PASS");
    expect(report.assertions.find((a) => a.id === "x")?.status).toBe("pass");
  });

  test("preflight assertions run before main ones regardless of input order", async () => {
    const order: string[] = [];
    const trace = (id: string) => async () => {
      order.push(id);
      return { pass: true as const };
    };
    await runGate([
      assertion("main", trace("main")),
      assertion("env", trace("env"), { group: "preflight" }),
    ]);
    expect(order).toEqual(["env", "main"]);
  });
});

describe("runGate — bounded parallelism", () => {
  test("main-group assertions run concurrently", async () => {
    const started: string[] = [];
    let release: () => void = () => {};
    const barrier = new Promise<void>((r) => {
      release = r;
    });
    const gate = runGate([
      assertion("a", async () => {
        started.push("a");
        await barrier;
        return { pass: true as const };
      }),
      assertion("b", async () => {
        started.push("b");
        await barrier;
        return { pass: true as const };
      }),
    ]);
    // Both must have entered before either completes — proving concurrency.
    await new Promise((r) => setTimeout(r, 20));
    expect(started.sort()).toEqual(["a", "b"]);
    release();
    expect((await gate).overall).toBe("PASS");
  });

  test("concurrency is capped so a wide gate cannot stampede the services", async () => {
    let inFlight = 0;
    let peak = 0;
    const slow = async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight -= 1;
      return { pass: true as const };
    };
    await runGate(
      Array.from({ length: 8 }, (_, i) => assertion(`a${i}`, slow)),
      { concurrency: 2 },
    );
    expect(peak).toBeLessThanOrEqual(2);
  });
});

describe("runGate — timeouts hold against REAL subprocesses", () => {
  // The mocked hang tests above use a never-resolving promise, which yields to
  // the event loop. They therefore cannot catch the class of bug where a check
  // spawns a child SYNCHRONOUSLY: spawnSync blocks the loop outright, so no
  // timer can preempt it and the whole pool serialises behind it. These tests
  // exercise the real spawning path the assertion modules use.
  test(
    "a slow child process is cut off at the assertion budget",
    async () => {
      const t0 = Date.now();
      const report = await runGate(
        [
          assertion("slow-child", async () => {
            await execFileAsync(process.execPath, ["-e", "setTimeout(()=>{}, 10000)"]);
            return { pass: true as const };
          }),
        ],
        { assertionTimeoutMs: 500 },
      );
      expect(report.assertions[0]?.status).toBe("fail");
      expect(report.assertions[0]?.detail).toMatch(/timed out/i);
      // Proves the timer actually preempted rather than waiting out the child.
      expect(Date.now() - t0).toBeLessThan(5_000);
    },
    30_000,
  );

  test(
    "a per-assertion timeout_ms override is honoured over the default",
    async () => {
      const report = await runGate(
        [
          assertion("needs-longer", async () => {
            await new Promise((r) => setTimeout(r, 300));
            return { pass: true as const };
          }, { timeout_ms: 5_000 }),
        ],
        { assertionTimeoutMs: 50 },
      );
      expect(report.assertions[0]?.status).toBe("pass");
    },
    30_000,
  );

  test(
    "child-spawning checks run concurrently, not serialised",
    async () => {
      const spawnOne = async () => {
        await execFileAsync(process.execPath, ["-e", "setTimeout(()=>{}, 700)"]);
        return { pass: true as const };
      };
      const t0 = Date.now();
      const report = await runGate(
        Array.from({ length: 4 }, (_, i) => assertion(`child${i}`, spawnOne)),
        { concurrency: 4, assertionTimeoutMs: 20_000 },
      );
      expect(report.overall).toBe("PASS");
      // Serialised would be ~2.8 s; concurrent should be well under that.
      expect(Date.now() - t0).toBeLessThan(2_200);
    },
    30_000,
  );
});

describe("runGate — total budget", () => {
  test("the gate stops at its total budget and marks unfinished work, not hangs", async () => {
    const report = await runGate(
      [assertion("hang", () => new Promise(() => {}))],
      { assertionTimeoutMs: 10_000, totalTimeoutMs: 60 },
    );
    expect(report.overall).toBe("FAIL");
    expect(report.assertions[0]?.detail).toMatch(/budget|timeout|timed out/i);
  });
});

describe("report schema", () => {
  test("a produced report validates against GateReportSchema", async () => {
    const report = await runGate([assertion("a", ok), assertion("b", bad)]);
    expect(() => GateReportSchema.parse(report)).not.toThrow();
  });

  test("the report carries an ISO timestamp and a total duration", async () => {
    const report = await runGate([assertion("a", ok)]);
    expect(Number.isNaN(Date.parse(report.timestamp))).toBe(false);
    expect(report.total_duration_ms).toBeGreaterThanOrEqual(0);
  });

  test("GateAssertionSchema accepts a well-formed assertion definition", () => {
    expect(() => GateAssertionSchema.parse(assertion("a", ok))).not.toThrow();
  });

  test("GateAssertionSchema rejects a definition missing its PRD clause", () => {
    const { prd_clause, ...rest } = assertion("a", ok);
    expect(() => GateAssertionSchema.parse(rest)).toThrow();
  });

  test("every assertion result carries the story and clause it traces to", async () => {
    const report = await runGate([assertion("a", ok, { story: "P0.7", prd_clause: "§13 P0 clause 6" })]);
    expect(report.assertions[0]?.story).toBe("P0.7");
    expect(report.assertions[0]?.prd_clause).toBe("§13 P0 clause 6");
  });

  test("the report counts pass/fail/skip/void so a reader need not re-tally", async () => {
    const report = await runGate([
      assertion("p", ok),
      assertion("f", bad),
      assertion("s", async () => ({ pass: false as const, skip: true })),
      assertion("v", ok, { void_reason: "killed" }),
    ]);
    expect(report.summary).toEqual({ pass: 1, fail: 1, skip: 1, void: 1 });
  });
});

describe("evidence-field coercion (false-green guard)", () => {
  test("well-formed counts pass through", () => {
    expect(asCount(4)).toBe(4);
    expect(asCount("3")).toBe(3);
  });

  test("a missing field reads as 0, which fails a >=2 threshold", () => {
    expect(asCount(undefined)).toBe(0);
    expect(asCount(null)).toBe(0);
    expect(!(asCount(undefined) >= 2)).toBe(true);
  });

  test("malformed fields yield NaN and FAIL the threshold, never satisfy it", () => {
    // The bug this guards: `NaN < 2` is false, so a naive `< 2` check would
    // record no failure and let corrupt evidence pass clause 2.
    for (const bad of ["n/a", {}, [1, 2], "abc"]) {
      const n = asCount(bad);
      expect(Number.isNaN(n)).toBe(true);
      expect(n < 2).toBe(false); // the trap a naive caller falls into
      expect(meetsMinCount(bad, 2)).toBe(false); // the enforced API
    }
  });
});

describe("meetsMinCount — the threshold contract is in the API, not convention", () => {
  test("accepts counts at or above the minimum", () => {
    expect(meetsMinCount(4, 2)).toBe(true);
    expect(meetsMinCount(2, 2)).toBe(true);
    expect(meetsMinCount("3", 2)).toBe(true);
  });

  test("rejects counts below the minimum", () => {
    expect(meetsMinCount(1, 2)).toBe(false);
    expect(meetsMinCount(0, 2)).toBe(false);
  });

  test("rejects missing and malformed evidence rather than letting it satisfy", () => {
    for (const bad of [undefined, null, "n/a", {}, "abc", Number.NaN]) {
      expect(meetsMinCount(bad, 2)).toBe(false);
    }
  });

  test("the regression scan's own pattern catches literal AND symbolic thresholds", () => {
    // Guards the guard: a literal-only pattern (`< \d`) silently stops
    // protecting the moment someone extracts the bound into a constant.
    const PATTERN = /\b(agents|messages|distinctModels|count)\w*\s*<=?\s*(\d|[A-Za-z_$][\w$]*)(?![\w$]*\s*>)/;
    for (const bad of [
      "if (agents < 2) fail();",
      "if (agents < MIN_AGENTS) fail();",
      "if (messages <= min) fail();",
      "if (distinctModels < REQUIRED) fail();",
      "if (countOfThings < n) fail();",
    ]) {
      expect(PATTERN.test(bad), `pattern missed: ${bad}`).toBe(true);
    }
    for (const good of [
      "if (!meetsMinCount(raw, 2)) fail();",
      "if (agents >= 2) ok();",
      "const agents = asCount(x);",
      // Generic type positions are not threshold comparisons — a naive
      // `<`-anything pattern would fail the guard for unrelated reasons.
      "const countMap = new Map<string, number>();",
      "let messagesByAc: Record<string, number>;",
    ]) {
      expect(PATTERN.test(good), `pattern false-positived: ${good}`).toBe(false);
    }
  });

  test("no assertion module carries a bare `< min` evidence comparison", async () => {
    // Guards the regression Sift flagged: the NaN-safety invariant must live in
    // meetsMinCount, not in each caller remembering to negate a >= test.
    const dir = path.join(REPO_ROOT, "src", "gate", "assertions");
    for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".ts"))) {
      const src = fs.readFileSync(path.join(dir, f), "utf8");
      // Strip comments so prose describing the trap does not trip the check.
      const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      // Matches BOTH numeric literals (`< 2`) and symbolic thresholds
      // (`< MIN_AGENTS`, `<= min`). A literal-only pattern would let a named
      // constant reintroduce exactly the bug this scan exists to prevent.
      // `<=` is included because `NaN <= min` is false for the same reason.
      expect(code, `${f} thresholds a count with a bare '<'/'<='`).not.toMatch(
        /\b(agents|messages|distinctModels|count)\w*\s*<=?\s*(\d|[A-Za-z_$][\w$]*)(?![\w$]*\s*>)/,
      );
    }
  });
});

describe("clause 8 — OQ decision audit", () => {
  const OQS = ["OQ-1", "OQ-2"] as const;
  const head = "## Appendix D — Phase-0 spike decision log\n\n| OQ | Status | Decision |\n|---|---|---|\n";
  const decision = "Decision recorded with ample rationale text here.";

  test("accepts RESOLVED and BLOCKED rows that carry a decision", () => {
    const md = `${head}| **OQ-1** | ✅ **RESOLVED (HIGH)** | ${decision} |\n| **OQ-2** | ⚠️ **BLOCKED-on-creds** | ${decision} |\n`;
    const { problems, statuses } = auditOqDecisions(md, OQS);
    expect(problems).toEqual([]);
    expect(statuses).toEqual(["OQ-1=RESOLVED", "OQ-2=BLOCKED+fallback"]);
  });

  test("UNRESOLVED does NOT satisfy the clause", () => {
    // The false green: /RESOLVED/ also matches "UNRESOLVED", so an explicitly
    // unresolved OQ would have certified clause 8.
    const md = `${head}| **OQ-1** | ❌ **UNRESOLVED** | ${decision} |\n| **OQ-2** | ✅ **RESOLVED** | ${decision} |\n`;
    const { problems } = auditOqDecisions(md, OQS);
    expect(problems.some((p) => p.startsWith("OQ-1"))).toBe(true);
  });

  test("a status with no decision text fails", () => {
    const md = `${head}| **OQ-1** | ✅ **RESOLVED** | TBD |\n| **OQ-2** | ✅ **RESOLVED** | ${decision} |\n`;
    const { problems } = auditOqDecisions(md, OQS);
    expect(problems.some((p) => p.includes("no recorded decision"))).toBe(true);
  });

  test("an OQ mentioned only AFTER Appendix D does not count", () => {
    const md = `${head}| **OQ-1** | ✅ **RESOLVED** | ${decision} |\n\n## Appendix E — Other\n\n| **OQ-2** | ✅ **RESOLVED** | ${decision} |\n`;
    const { problems } = auditOqDecisions(md, OQS);
    expect(problems.some((p) => p.startsWith("OQ-2"))).toBe(true);
  });

  test("H3 subsections inside Appendix D do not truncate the table", () => {
    // Bounding at any ###/## dropped rows below a subsection -> false FAILURE.
    const md = `${head}| **OQ-1** | ✅ **RESOLVED** | ${decision} |\n\n### D.1 Notes\n\n| **OQ-2** | ✅ **RESOLVED** | ${decision} |\n`;
    const { problems } = auditOqDecisions(md, OQS);
    expect(problems).toEqual([]);
  });

  test("a missing Appendix D is reported, not silently passed", () => {
    const { problems } = auditOqDecisions("# PRD\n\nno appendix here\n", OQS);
    expect(problems.length).toBeGreaterThan(0);
  });

  test("the real PRD satisfies clause 8 for all six OQs", () => {
    const prd = fs.readFileSync(
      path.join(REPO_ROOT, "_bmad-output", "planning-artifacts", "prd-qds-factory-v4.md"),
      "utf8",
    );
    const { problems, statuses } = auditOqDecisions(prd, [
      "OQ-1", "OQ-2", "OQ-3", "OQ-4", "OQ-5", "OQ-6",
    ]);
    expect(problems).toEqual([]);
    expect(statuses).toHaveLength(6);
  });
});

describe("gate script process contract", () => {
  const TIMEOUT_MS = 900_000;

  test(
    "emits a PHASE_0_GATE marker, an exit code that agrees with it, and a valid report",
    () => {
      const reportPath = path.join(
        fs.mkdtempSync(path.join(os.tmpdir(), "p0-gate-")),
        "phase0-gate-report.json",
      );
      const run = spawnSync("bun", [GATE, "--report", reportPath], {
        cwd: REPO_ROOT,
        encoding: "utf8",
        timeout: 870_000,
      });

      // A red gate on an unprovisioned host is a CORRECT outcome. Assert the
      // contract holds in both directions rather than demanding green.
      // Surface a spawn failure or timeout directly — otherwise the first
      // symptom is a confusing `passed || failed` assertion against empty stdout.
      expect(run.error, `gate did not run: ${run.error?.message ?? ""}`).toBeUndefined();

      const stdout = run.stdout ?? "";
      const passed = stdout.includes("PHASE_0_GATE: PASS");
      const failed = stdout.includes("PHASE_0_GATE: FAIL");
      expect(passed || failed).toBe(true);
      expect(passed && failed).toBe(false);
      expect(run.status).toBe(passed ? 0 : 1);

      expect(fs.existsSync(reportPath)).toBe(true);
      const parsed = GateReportSchema.parse(JSON.parse(fs.readFileSync(reportPath, "utf8")));
      expect(parsed.overall).toBe(passed ? "PASS" : "FAIL");

      // AC2: a red gate must name its failing assertions, never a bare summary.
      if (failed) {
        const reds = parsed.assertions.filter((a) => a.status === "fail" || a.status === "skip");
        expect(reds.length).toBeGreaterThan(0);
        for (const red of reds) {
          expect(stdout).toContain(red.id);
          expect(red.detail && red.detail.length > 0).toBe(true);
        }
      }
    },
    TIMEOUT_MS,
  );
});
