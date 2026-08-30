/**
 * `reverify(runId)` end-to-end tests (Story DF5.1).
 *
 * These run against a REAL throwaway git repository with a real quarantine ref
 * and a real `bun test` subprocess. That is deliberate: the story's whole claim
 * is that the verdict rests on the fetched git objects and the host toolchain,
 * and a mocked runner would let an implementation that reads the box's claim
 * pass every one of these.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

import { RunRecordStore } from "../../src/providers/run-record.ts";
import type { ApprovalOutcome, ApprovalPort } from "../../src/reverify/index.ts";
import { readReports, reverify } from "../../src/reverify/index.ts";
import { makeHarvestedRepo, type HarvestedRepo, type HarvestedRepoOptions } from "./fixtures/harvested-repo.ts";

interface Harness {
  repo: HarvestedRepo;
  store: RunRecordStore;
  runsDir: string;
  reverifyDir: string;
  calls: { runId: string; reportId: string; headSha: string; proposal: string }[];
  approval: ApprovalPort;
  cleanup(): void;
}

/** A recording port: DF5.1 owns the CALLER, so the caller is what we assert. */
function recordingPort(
  calls: Harness["calls"],
  outcome: ApprovalOutcome = { outcome: "requested" },
): ApprovalPort {
  return {
    async requestApproval(runId, req) {
      calls.push({ runId, ...req });
      return outcome;
    },
  };
}

const HOST_MANIFEST = {
  version: "1.0.0",
  pipelineId: "host-verify",
  runBudgetMs: 1_200_000,
  phases: [
    {
      name: "tests",
      kind: "code",
      description: "host-pinned test run",
      maxDurationMs: 150_000,
      retries: 0,
      command: ["bun", "test", "t/"],
      testCommand: ["bun", "test", "t/"],
    },
    {
      name: "tree-clean",
      kind: "code",
      description: "host-pinned working tree gate",
      maxDurationMs: 150_000,
      retries: 0,
      command: ["git", "status", "--porcelain"],
    },
  ],
};

async function harness(
  opts: HarvestedRepoOptions & { hostManifest?: unknown; noTestSuite?: boolean; noHostPlan?: boolean } = {},
): Promise<Harness> {
  const repo = await makeHarvestedRepo(opts);
  const runsDir = path.join(repo.dir, ".sandbox", "runs");
  const store = new RunRecordStore({ dir: runsDir });
  store.create(repo.runId);
  store.set(repo.runId, {
    commitSha: repo.baseSha,
    requestId: "req-df5-1",
    extensions: { budget: { repoSlug: "acme/widget", issueId: "1" } },
  });
  // Harvest's invariant is that `<runsDir>/<runId>.bundle` EXISTS for a
  // harvested run (harvest.ts:435-436), and the wired `bundleDir` guard checks
  // it on the default approval path — a harnessed run is a harvested run, so
  // it plants one. Content is irrelevant; the guard is an existence check.
  fs.writeFileSync(path.join(runsDir, `${repo.runId}.bundle`), "bundle");

  if (opts.noHostPlan !== true) {
    fs.mkdirSync(path.join(repo.dir, ".factory", "manifests"), { recursive: true });
    fs.writeFileSync(
      path.join(repo.dir, ".factory", "manifests", "acme-widget.json"),
      JSON.stringify(opts.hostManifest ?? HOST_MANIFEST),
    );
    fs.writeFileSync(
      path.join(repo.dir, ".factory", "pipeline.json"),
      JSON.stringify({
        version: 1,
        repos: {
          "acme/widget": {
            manifest: ".factory/manifests/acme-widget.json",
            ...(opts.noTestSuite === true ? { noTestSuite: true } : {}),
          },
        },
      }),
    );
  }

  const calls: Harness["calls"] = [];
  return {
    repo,
    store,
    runsDir,
    reverifyDir: path.join(repo.dir, ".sandbox", "reverify"),
    calls,
    approval: recordingPort(calls),
    cleanup: () => repo.cleanup(),
  };
}

function deps(h: Harness, over: Record<string, unknown> = {}) {
  return {
    store: h.store,
    runsDir: h.runsDir,
    hostRoot: h.repo.dir,
    reverifyDir: h.reverifyDir,
    worktreeRoot: path.join(h.repo.dir, ".sandbox", "reverify-wt"),
    approval: h.approval,
    log: () => undefined,
    ...over,
  };
}

/** The box's merged step output (DF1.6's shape), as harvest leaves it. */
function plantClaim(h: Harness, claim: Record<string, unknown>): string {
  const dir = path.join(h.runsDir, `${h.repo.runId}-artifacts`);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "merged.json");
  fs.writeFileSync(file, JSON.stringify(claim));
  return dir;
}

describe("reverify — the e2e slice (MANDATORY demo)", () => {
  test("three harvested commits re-verify green, and one seeded failing test flips it to red", async () => {
    const green = await harness();
    try {
      plantClaim(green, {
        exitStatus: "success",
        testResults: { passed: 1, failed: 0 },
        changedFiles: ["src/sum.ts", "t/sum.test.ts"],
      });
      const { report, approval } = await reverify(green.repo.runId, deps(green));

      expect(report.verdict).toBe("green");
      expect(report.headSha).toBe(green.repo.headSha);
      expect(report.baseSha).toBe(green.repo.baseSha);
      expect(report.testResults).toEqual({ passed: 1, failed: 0 });
      expect(report.discrepancies).toEqual([]);
      expect(report.checks.length).toBeGreaterThan(0);
      expect(report.checks.every((c) => c.note.length > 0)).toBe(true);
      expect(approval).toEqual({ outcome: "requested" });
      // Worktree pruned.
      expect(fs.existsSync(path.join(green.repo.dir, ".sandbox", "reverify-wt", green.repo.runId))).toBe(false);
    } finally {
      green.cleanup();
    }

    const red = await harness({ failing: true });
    try {
      plantClaim(red, {
        exitStatus: "success",
        testResults: { passed: 1, failed: 0 },
        changedFiles: ["src/sum.ts", "t/sum.test.ts"],
      });
      const { report, approval } = await reverify(red.repo.runId, deps(red));

      expect(report.verdict).toBe("red");
      expect(report.testResults.failed).toBe(1);
      expect(report.discrepancies).toContain("testResults.failed: claimed 0, host 1");
      expect(approval).toBeNull();
    } finally {
      red.cleanup();
    }
  }, 120_000);
});

describe("INV-RV-1 — evidence authority (negative control)", () => {
  test("deleting every harvested artifact leaves the verdict and checks identical", async () => {
    const h = await harness();
    try {
      const artifacts = plantClaim(h, {
        exitStatus: "success",
        testResults: { passed: 999, failed: 0 },
        changedFiles: [],
      });
      const withArtifacts = await reverify(h.repo.runId, deps(h));
      expect(withArtifacts.report.claimed).not.toBeNull();

      fs.rmSync(artifacts, { recursive: true, force: true });
      const without = await reverify(h.repo.runId, deps(h));

      expect(without.report.claimed).toBeNull();
      expect(without.report.verdict).toBe(withArtifacts.report.verdict);
      expect(without.report.testResults).toEqual(withArtifacts.report.testResults);
      expect(without.report.checks.map((c) => `${c.item}:${c.ok}`)).toEqual(
        withArtifacts.report.checks.map((c) => `${c.item}:${c.ok}`),
      );
      // The claim WAS wildly different — an implementation reading it would
      // have reported 999 passes on the first run.
      expect(withArtifacts.report.testResults.passed).toBe(1);
    } finally {
      h.cleanup();
    }
  }, 120_000);

  test("a box claiming success cannot raise a red host verdict (AC3)", async () => {
    const h = await harness({ failing: true });
    try {
      plantClaim(h, { exitStatus: "success", testResults: { passed: 1, failed: 0 }, changedFiles: [] });
      const { report } = await reverify(h.repo.runId, deps(h));
      expect(report.verdict).toBe("red");
      expect(report.discrepancies).toContain('exitStatus: claimed "success", host verdict red');
    } finally {
      h.cleanup();
    }
  }, 120_000);

  test("a box claiming failure does not lower a green host verdict (AC3)", async () => {
    const h = await harness();
    try {
      plantClaim(h, { exitStatus: "logic", testResults: { passed: 0, failed: 7 }, changedFiles: [] });
      const { report } = await reverify(h.repo.runId, deps(h));
      expect(report.verdict).toBe("green");
      expect(report.discrepancies).toContain("testResults.failed: claimed 7, host 0");
    } finally {
      h.cleanup();
    }
  }, 120_000);
});

describe("AC2 — the tree never supplies the command that judges it", () => {
  test("an in-tree manifest replacing the test command with `true` is flagged, never applied", async () => {
    const h = await harness({ divergentManifest: true, failing: true });
    try {
      const { report } = await reverify(h.repo.runId, deps(h));
      // The in-tree manifest says `true`; the host plan still ran bun test.
      expect(report.verdict).toBe("red");
      expect(report.testResults.failed).toBe(1);
      expect(report.flags).toContain("manifest-divergence");
      expect(report.checks.some((c) => c.item.startsWith("tests: bun test"))).toBe(true);
    } finally {
      h.cleanup();
    }
  }, 120_000);

  test("no host plan entry for the repoSlug is an error verdict with no worktree", async () => {
    const h = await harness({ noHostPlan: true });
    try {
      const { report, approval } = await reverify(h.repo.runId, deps(h));
      expect(report.verdict).toBe("error");
      expect(report.failure?.code).toBe("no-host-plan");
      expect(approval).toBeNull();
      expect(fs.existsSync(path.join(h.repo.dir, ".sandbox", "reverify-wt", h.repo.runId))).toBe(false);
    } finally {
      h.cleanup();
    }
  }, 120_000);
});

describe("AC4 / INV-RV-5 — error is never green", () => {
  test("removing the test runner from the resolved toolchain yields error, not green", async () => {
    const h = await harness();
    try {
      const { report, approval } = await reverify(
        h.repo.runId,
        deps(h, {
          tools: [
            { name: "git", argv: ["git", "--version"] },
            { name: "bun", argv: ["/nonexistent/bun-that-is-not-installed", "--version"] },
          ],
        }),
      );
      expect(report.verdict).toBe("error");
      expect(report.verdict === "green").toBe(false);
      expect(report.failure?.code).toBe("toolchain-missing");
      expect(approval).toBeNull();
      // The probe runs BEFORE the worktree add, so none was ever created.
      expect(fs.existsSync(path.join(h.repo.dir, ".sandbox", "reverify-wt", h.repo.runId))).toBe(false);
    } finally {
      h.cleanup();
    }
  }, 120_000);

  test("a deleted quarantine ref resolves to an empty harvest, not a crash", async () => {
    const h = await harness();
    try {
      h.repo.git(["git", "update-ref", "-d", `refs/sandbox/${h.repo.runId}`]);
      const { report } = await reverify(h.repo.runId, deps(h));
      expect(report.verdict).toBe("red");
      expect(report.reason).toBe("nothing-to-verify");
    } finally {
      h.cleanup();
    }
  }, 120_000);

  test("a run record with no commitSha is an error verdict naming the cause", async () => {
    const h = await harness();
    try {
      const bare = new RunRecordStore({ dir: h.runsDir });
      bare.create("run-bare");
      h.repo.git(["git", "update-ref", "refs/sandbox/run-bare", h.repo.headSha]);
      const { report } = await reverify("run-bare", deps(h));
      expect(report.verdict).toBe("error");
      expect(report.failure?.code).toBe("no-base-sha");
    } finally {
      h.cleanup();
    }
  }, 120_000);

  test("the error verdict exits the CLI non-zero", async () => {
    const h = await harness({ noHostPlan: true });
    try {
      const proc = Bun.spawn(["bun", path.join(process.cwd(), "scripts", "reverify.ts"), h.repo.runId], {
        cwd: h.repo.dir,
        env: { ...process.env, QDS_RUNS_DIR: h.runsDir },
        stdout: "pipe",
        stderr: "pipe",
      });
      const code = await proc.exited;
      expect(code).toBe(2);
    } finally {
      h.cleanup();
    }
  }, 120_000);
});

describe("AC5 — the empty-harvest boundary", () => {
  test("zero commits beyond base is red/nothing-to-verify, no worktree, no throw", async () => {
    const h = await harness();
    try {
      h.repo.git(["git", "update-ref", `refs/sandbox/${h.repo.runId}`, h.repo.baseSha]);
      const { report, approval } = await reverify(h.repo.runId, deps(h));

      expect(report.verdict).toBe("red");
      expect(report.reason).toBe("nothing-to-verify");
      expect(approval).toBeNull();
      expect(fs.existsSync(path.join(h.repo.dir, ".sandbox", "reverify-wt", h.repo.runId))).toBe(false);
      expect(readReports(h.reverifyDir, h.repo.runId).length).toBe(1);
    } finally {
      h.cleanup();
    }
  }, 120_000);
});

describe("AC6 — the single owner of the requestApproval caller", () => {
  test("a green verdict requests approval exactly once, bound to THIS report, and opens no PR", async () => {
    const h = await harness();
    try {
      const { report } = await reverify(h.repo.runId, deps(h));
      expect(report.verdict).toBe("green");
      expect(h.calls.length).toBe(1);
      expect(h.calls[0]!.reportId).toBe(report.reverifyId);
      expect(h.calls[0]!.headSha).toBe(report.headSha);
      // No PR surface is reachable from this code path at all.
      expect(JSON.stringify(report)).not.toContain("prUrl");
    } finally {
      h.cleanup();
    }
  }, 120_000);

  test("a red verdict requests approval zero times", async () => {
    const h = await harness({ failing: true });
    try {
      const { report } = await reverify(h.repo.runId, deps(h));
      expect(report.verdict).toBe("red");
      expect(h.calls.length).toBe(0);
    } finally {
      h.cleanup();
    }
  }, 120_000);

  test("an error verdict requests approval zero times", async () => {
    const h = await harness({ noHostPlan: true });
    try {
      const { report } = await reverify(h.repo.runId, deps(h));
      expect(report.verdict).toBe("error");
      expect(h.calls.length).toBe(0);
    } finally {
      h.cleanup();
    }
  }, 120_000);

  test("a pausing record: no request, and the report carries approval-pause-in-progress", async () => {
    const h = await harness();
    try {
      const calls: Harness["calls"] = [];
      const { report } = await reverify(
        h.repo.runId,
        deps(h, { approval: recordingPort(calls, { outcome: "pause-in-progress" }) }),
      );
      expect(report.verdict).toBe("green");
      expect(report.flags).toContain("approval-pause-in-progress");
      // The port was consulted, but DF3.4's record was left alone — that is
      // what the port's `pause-in-progress` outcome MEANS.
      expect(calls.length).toBe(1);
    } finally {
      h.cleanup();
    }
  }, 120_000);

  test("an approval intake that throws leaves a flagged report, never an uncaught throw", async () => {
    const h = await harness();
    try {
      const throwing: ApprovalPort = {
        async requestApproval() {
          throw new Error("DF3.4 intake unavailable");
        },
      };
      const { report, approval } = await reverify(h.repo.runId, deps(h, { approval: throwing }));
      // The tree DID verify green — the host says so — but no approval was
      // requested, so DF5.2 has nothing to push behind.
      expect(report.verdict).toBe("green");
      expect(report.flags).toContain("approval-request-failed");
      expect(approval).toBeNull();
      expect(readReports(h.reverifyDir, h.repo.runId).at(-1)!.flags).toContain("approval-request-failed");
    } finally {
      h.cleanup();
    }
  }, 120_000);

  test("a terminal record: no request, and the report carries approval-already-decided", async () => {
    const h = await harness();
    try {
      const calls: Harness["calls"] = [];
      const { report } = await reverify(
        h.repo.runId,
        deps(h, { approval: recordingPort(calls, { outcome: "already-decided", state: "approved" }) }),
      );
      expect(report.flags).toContain("approval-already-decided");
    } finally {
      h.cleanup();
    }
  }, 120_000);

  test("the default adapter rebinds an awaiting record on a re-verify rather than bricking the run", async () => {
    const h = await harness();
    try {
      // No `approval` override: exercise the real RunRecord-backed adapter.
      const first = await reverify(h.repo.runId, deps(h, { approval: undefined }));
      const second = await reverify(h.repo.runId, deps(h, { approval: undefined }));

      expect(first.report.verdict).toBe("green");
      expect(second.approval).toEqual({
        outcome: "rebound",
        supersededReportId: first.report.reverifyId,
      });
      const ext = h.store.get(h.repo.runId).extensions?.approval;
      expect(ext?.reportId).toBe(second.report.reverifyId);
      // Record-side history is the ARRAY (DF3.4 W4); the singular on the
      // OUTCOME above is derived per-call and is asserted unchanged.
      expect(ext?.supersededReportIds).toEqual([first.report.reverifyId]);
      expect(ext?.state).toBe("awaiting-approval");
    } finally {
      h.cleanup();
    }
  }, 120_000);

  test("a retry after a stranded pausing extension RE-PRESENTS the bound reportId and resumes", async () => {
    const h = await harness();
    try {
      // The crash window: `pausing` was registered and the process died before
      // promotion. No `approval` override — the real adapter over the real
      // gate, whose resume arm fires only on a byte-identical reportId.
      h.store.set(h.repo.runId, {
        extensions: {
          approval: {
            state: "pausing",
            proposal: "p",
            reportId: "rv-stranded",
            headSha: "c".repeat(40),
            requestedAt: new Date().toISOString(),
          },
        },
      });
      const { report, approval } = await reverify(h.repo.runId, deps(h, { approval: undefined }));

      expect(report.verdict).toBe("green");
      // A freshly minted reverifyId here is the bug: the gate would answer
      // `pause-in-progress` on every retry and the run would strand forever.
      // Re-presenting the BOUND id reaches the resume arm, which promotes.
      expect(approval).toEqual({ outcome: "requested" });
      const ext = h.store.get(h.repo.runId).extensions?.approval;
      expect(ext?.state).toBe("awaiting-approval");
      expect(ext?.reportId).toBe("rv-stranded");
      // The report itself keeps its own fresh id — it IS a new report; only
      // the request re-presents the stranded binding.
      expect(report.reverifyId).not.toBe("rv-stranded");
    } finally {
      h.cleanup();
    }
  }, 120_000);

  test("a green verdict whose harvested bundle is GONE is refused by the wired bundle guard", async () => {
    const h = await harness();
    try {
      fs.rmSync(path.join(h.runsDir, `${h.repo.runId}.bundle`));
      const { report, approval } = await reverify(h.repo.runId, deps(h, { approval: undefined }));

      // The tree DID verify green, but a report naming a run with no bundle
      // is bound to nothing: the request is refused, flagged on the report,
      // and no approval extension was registered.
      expect(report.verdict).toBe("green");
      expect(report.flags).toContain("approval-request-failed");
      expect(approval).toBeNull();
      expect(h.store.get(h.repo.runId).extensions?.approval).toBeUndefined();
    } finally {
      h.cleanup();
    }
  }, 120_000);
});

describe("persistence and determinism", () => {
  test("re-running appends a new report; both are retained and the last is authoritative", async () => {
    const h = await harness();
    try {
      const first = await reverify(h.repo.runId, deps(h));
      const second = await reverify(h.repo.runId, deps(h));
      const all = readReports(h.reverifyDir, h.repo.runId);

      expect(all.length).toBe(2);
      expect(all[0]!.reverifyId).toBe(first.report.reverifyId);
      expect(all.at(-1)!.reverifyId).toBe(second.report.reverifyId);
      expect(first.report.reverifyId).not.toBe(second.report.reverifyId);
    } finally {
      h.cleanup();
    }
  }, 120_000);

  test("two runs at the same sha that disagree force red and flag nondeterministic", async () => {
    const h = await harness();
    try {
      // A prior RED at this exact sha. The tree is green now, so the two runs
      // disagree — which is a flake, and §8 step 0 refuses to retry a flake
      // into a pass.
      const first = await reverify(h.repo.runId, deps(h));
      expect(first.report.verdict).toBe("green");
      const forgedRed = { ...first.report, reverifyId: "rv-prior", verdict: "red", reason: "tests-failed" };
      fs.appendFileSync(
        path.join(h.reverifyDir, `${h.repo.runId}.jsonl`),
        `${JSON.stringify(forgedRed)}\n`,
      );

      const second = await reverify(h.repo.runId, deps(h));
      expect(second.report.verdict).toBe("red");
      expect(second.report.flags).toContain("nondeterministic");
      expect(second.approval).toBeNull();
    } finally {
      h.cleanup();
    }
  }, 120_000);
});

describe("INV-RV-3 / INV-RV-4 — credentials and redaction", () => {
  test("the verify process carries no credential-shaped env key", async () => {
    const { verifyEnv } = await import("../../src/reverify/runner.ts");
    const env = verifyEnv({
      PATH: "/usr/bin",
      ANTHROPIC_API_KEY: "sk-ant-should-not-survive",
      GITHUB_TOKEN: "ghp_should-not-survive",
      QDS_APPROVER_TOKEN: "appr-should-not-survive",
      HOME: "/home/t",
    });
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/t");
    expect(Object.keys(env)).not.toContain("ANTHROPIC_API_KEY");
    expect(Object.keys(env)).not.toContain("GITHUB_TOKEN");
    expect(Object.keys(env)).not.toContain("QDS_APPROVER_TOKEN");
    expect(JSON.stringify(env)).not.toContain("should-not-survive");
  });

  test("a sentinel planted in GATE OUTPUT is redacted against the run's own map, not process.env", async () => {
    // The sentinel is deliberately NOT in process.env — INV-RV-3 already
    // stripped the real credentials from the verify process, so an
    // implementation redacting against the environment finds nothing to redact
    // and MUST fail this test.
    const sentinel = "qds-sentinel-9f2a7c41d0e6b8";
    expect(JSON.stringify(process.env)).not.toContain(sentinel);

    const manifest = structuredClone(HOST_MANIFEST) as typeof HOST_MANIFEST & {
      phases: { command: string[]; testCommand?: string[] }[];
    };
    // A gate that fails while echoing the sentinel: commandGate keeps the
    // output tail as evidence, which is exactly the leak path INV-RV-4 closes.
    manifest.phases[1]!.command = ["bash", "-c", `echo "leaked ${sentinel}"; exit 1`];

    const h = await harness({ hostManifest: manifest });
    try {
      const { report } = await reverify(
        h.repo.runId,
        deps(h, { redaction: { QDS_PROVIDER_KEY: sentinel } }),
      );
      const serialized = JSON.stringify(report);
      expect(serialized).toContain("[REDACTED:QDS_PROVIDER_KEY]");
      expect(serialized).not.toContain(sentinel);
    } finally {
      h.cleanup();
    }
  }, 120_000);
});

describe("observability contract", () => {
  test("every step logs the join keys and its own duration", async () => {
    const h = await harness();
    try {
      const events: Record<string, unknown>[] = [];
      const { report } = await reverify(h.repo.runId, deps(h, { log: (e: Record<string, unknown>) => events.push(e) }));

      expect(events.length).toBeGreaterThan(0);
      for (const e of events) {
        expect(e.runId).toBe(h.repo.runId);
        expect(e.reverifyId).toBe(report.reverifyId);
        expect(typeof e.timestamp).toBe("string");
        expect(typeof e.durationMs).toBe("number");
      }
      // requestId propagates from the dispatch via the run record (DF3.1).
      expect(events.at(-1)!.requestId).toBe("req-df5-1");
      expect(events.map((e) => e.step)).toContain("worktree");
      expect(events.map((e) => e.step)).toContain("tests");
      expect(events.map((e) => e.step)).toContain("gates");
      // A step that did not run still reports 0; durationMs stays authoritative.
      expect(report.timings.cleanup_ms).toBeGreaterThanOrEqual(0);
      expect(report.durationMs).toBeGreaterThan(0);
    } finally {
      h.cleanup();
    }
  }, 120_000);
});
