import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  aggregate,
  type ArmName,
  type ArmResult,
  firstTurnInputTokens,
  manifestForArm,
  mergedExitStatus,
  MIN_RUNS_PER_ARM,
  preflight,
  type RunObservation,
  SUPPORTED_RATIO,
  workerAgentIds,
  workerModels,
} from "../scripts/lean-worker-benchmark.ts";

const HELP = "  --no-extensions, -ne  ...\n  --no-skills, -ns  ...\n";

function run(
  iteration: number,
  agentId: string,
  firstTurn: number,
  usageBearingTurns = 2,
): RunObservation {
  return {
    iteration,
    agentId,
    model: "openrouter/stub",
    firstTurnInputTokens: firstTurn,
    usageBearingTurns,
    durationMs: 100,
    exitStatus: "success",
  };
}

function arm(name: ArmName, runs: RunObservation[], n = MIN_RUNS_PER_ARM): ArmResult {
  return { arm: name, n, startedAt: "2026-08-13T00:00:00Z", durationMs: 300, runs };
}

const agg = (control: ArmResult, lean: ArmResult) =>
  aggregate("req-1", "m.yaml", control, lean, []);

describe("firstTurnInputTokens", () => {
  const turn = (input: number): string =>
    `{"type":"message_end","message":{"role":"assistant","usage":{"input":${input},"output":1,"cost":{"total":0.1}}}}`;

  it("returns the FIRST usage-bearing turn, not the last or the sum", () => {
    const parsed = firstTurnInputTokens(`${turn(37279)}\n${turn(41000)}\n${turn(52000)}`);
    expect(parsed).toEqual({ inputTokens: 37279, usageBearingTurns: 3 });
  });

  it("ignores the duplicate usage pi repeats on non-message_end events", () => {
    const stream = [
      '{"type":"message_start","message":{"role":"assistant","usage":{"input":999,"output":0,"cost":{"total":0}}}}',
      '{"type":"message_update","message":{"role":"assistant","usage":{"input":999,"output":0,"cost":{"total":0}}}}',
      turn(37279),
      '{"type":"turn_end","message":{"role":"assistant","usage":{"input":37279,"output":1,"cost":{"total":0.1}}}}',
    ].join("\n");
    expect(firstTurnInputTokens(stream)?.inputTokens).toBe(37279);
    expect(firstTurnInputTokens(stream)?.usageBearingTurns).toBe(1);
  });

  it("ignores toolResult turns", () => {
    const stream = `{"type":"message_end","message":{"role":"toolResult","usage":{"input":999999,"output":1,"cost":{"total":9}}}}\n${turn(37279)}`;
    expect(firstTurnInputTokens(stream)?.inputTokens).toBe(37279);
  });

  it("returns null for a stream with no usage-bearing turns", () => {
    expect(firstTurnInputTokens("")).toBeNull();
    expect(firstTurnInputTokens('{"type":"agent_start"}\nnot json\n')).toBeNull();
    expect(
      firstTurnInputTokens('{"type":"message_end","message":{"role":"assistant"}}'),
    ).toBeNull();
  });

  it("skips malformed input values rather than counting them", () => {
    const bad = '{"type":"message_end","message":{"role":"assistant","usage":{"input":-5}}}';
    expect(firstTurnInputTokens(`${bad}\n${turn(100)}`)?.inputTokens).toBe(100);
  });
});

describe("aggregate — the measurement is the deliverable (AC1)", () => {
  it("reports supported at or above the 5.0 hypothesis ratio", () => {
    const v = agg(
      arm("control", [run(1, "w", 40000), run(2, "w", 40000), run(3, "w", 40000)]),
      arm("lean", [run(1, "w", 8000), run(2, "w", 8000), run(3, "w", 8000)]),
    );
    expect(v.hypothesisVerdict).toBe("supported");
    expect(v.ratio).toBeCloseTo(5.0, 10);
    expect(v.deltaTokens).toBe(32000);
    expect(v.perWorker[0]?.controlMeanFirstTurnInputTokens).toBe(40000);
    expect(v.perWorker[0]?.leanMeanFirstTurnInputTokens).toBe(8000);
  });

  it("reports refuted below it — the story passes on a refutation (AC1)", () => {
    const v = agg(
      arm("control", [run(1, "w", 40000), run(2, "w", 40000), run(3, "w", 40000)]),
      arm("lean", [run(1, "w", 20000), run(2, "w", 20000), run(3, "w", 20000)]),
    );
    expect(v.hypothesisVerdict).toBe("refuted");
    expect(v.ratio).toBeCloseTo(2.0, 10);
    // deltaTokens is recorded BESIDE the verdict: a big task prompt inflates
    // both arms and drags the ratio under 5 while the lever worked. A reader
    // must be able to see that from the artifact.
    expect(v.deltaTokens).toBe(20000);
    expect(SUPPORTED_RATIO).toBe(5.0);
  });

  it("records every arm's per-run observations and sub-timings", () => {
    const v = agg(
      arm("control", [run(1, "w", 40000), run(2, "w", 41000), run(3, "w", 39000)]),
      arm("lean", [run(1, "w", 8000), run(2, "w", 8000), run(3, "w", 8000)]),
    );
    expect(v.arms.control.n).toBe(3);
    expect(v.arms.control.runs).toHaveLength(3);
    expect(v.control_arm_ms).toBe(300);
    expect(v.lean_arm_ms).toBe(300);
    expect(v.perWorker[0]?.controlMeanFirstTurnInputTokens).toBe(40000);
  });
});

describe("aggregate — fail closed (AC4, INV-5)", () => {
  const expectInconclusive = (v: ReturnType<typeof agg>): void => {
    expect(v.hypothesisVerdict).toBe("inconclusive");
    // No ratio FIELD at all — not null, not Infinity.
    expect("ratio" in v).toBe(false);
    expect(v.errors.length).toBeGreaterThan(0);
  };

  it("refuses to average over the surviving arm when one arm has zero usage-bearing turns", () => {
    const v = agg(
      arm("control", [run(1, "w", 40000), run(2, "w", 40000), run(3, "w", 40000)]),
      arm("lean", [run(1, "w", 0, 0), run(2, "w", 8000), run(3, "w", 8000)]),
    );
    expectInconclusive(v);
    expect(v.errors[0]?.code).toBe("zero_usage_bearing_turns");
    expect(v.errors[0]?.arm).toBe("lean");
    expect(v.errors[0]?.agentId).toBe("w");
    // No saving is reported for the failing worker.
    expect(v.perWorker.find((w) => w.agentId === "w")).toBeUndefined();
  });

  it("is inconclusive when an arm is underpowered (n < 3)", () => {
    const v = agg(
      arm("control", [run(1, "w", 40000), run(2, "w", 40000)], 2),
      arm("lean", [run(1, "w", 8000), run(2, "w", 8000), run(3, "w", 8000)]),
    );
    expectInconclusive(v);
    expect(v.errors[0]?.code).toBe("arm_underpowered");
    expect(v.errors[0]?.arm).toBe("control");
  });

  it("is inconclusive on a zero lean mean — never Infinity, never a null ratio", () => {
    const v = agg(
      arm("control", [run(1, "w", 40000), run(2, "w", 40000), run(3, "w", 40000)]),
      arm("lean", [run(1, "w", 0), run(2, "w", 0), run(3, "w", 0)]),
    );
    expectInconclusive(v);
    expect(v.errors.some((e) => e.code === "zero_lean_mean")).toBe(true);
    // deltaTokens is still recorded; only the ratio is withheld.
    const w = v.perWorker.find((x) => x.agentId === "w");
    expect(w?.deltaTokens).toBe(40000);
    expect(w?.ratio).toBeUndefined();
  });

  it("is inconclusive when a worker is missing from the lean arm entirely", () => {
    const v = agg(
      arm("control", [run(1, "a", 40000), run(2, "a", 40000), run(3, "b", 40000)]),
      arm("lean", [run(1, "a", 8000), run(2, "a", 8000), run(3, "a", 8000)]),
    );
    expectInconclusive(v);
    expect(v.errors.some((e) => e.code === "worker_missing_from_arm")).toBe(true);
  });

  it("is inconclusive when neither arm produced any worker run", () => {
    expectInconclusive(agg(arm("control", []), arm("lean", [])));
  });

  it("does not let a worker vanish from the CONTROL arm unnoticed", () => {
    // The mirror of the lean-arm case. Deriving the agent set from the
    // observed runs made a control-arm spawn failure DELETE the worker from
    // the report — the run then returned `supported` with a ratio computed
    // from the survivors and an empty errors list. The expected set comes
    // from the manifest, so a missing worker fails the run instead.
    const v = aggregate(
      "req-1",
      "m.yaml",
      arm("control", [run(1, "a", 40000), run(2, "a", 40000), run(3, "a", 40000)]),
      arm("lean", [
        run(1, "a", 8000),
        run(2, "a", 8000),
        run(3, "a", 8000),
        run(1, "b", 40000),
        run(2, "b", 40000),
        run(3, "b", 40000),
      ]),
      [],
      [],
      ["a", "b"],
    );
    expect(v.hypothesisVerdict).toBe("inconclusive");
    expect("ratio" in v).toBe(false);
    const missing = v.errors.find((e) => e.code === "worker_missing_from_arm");
    expect(missing?.arm).toBe("control");
    expect(missing?.agentId).toBe("b");
  });

  it("does not average a worker with fewer than 3 observations even when arm n says 3", () => {
    // `n` counts iterations ATTEMPTED. An arm can report n=3 while a given
    // worker produced a single observation; averaging that as a 3-run mean is
    // the same fail-open in a quieter form.
    const v = aggregate(
      "req-1",
      "m.yaml",
      arm("control", [run(1, "a", 40000)]),
      arm("lean", [run(1, "a", 8000), run(2, "a", 8000), run(3, "a", 8000)]),
      [],
      [],
      ["a"],
    );
    expect(v.hypothesisVerdict).toBe("inconclusive");
    expect("ratio" in v).toBe(false);
    expect(v.errors.some((e) => e.code === "worker_underpowered")).toBe(true);
  });

  it("is inconclusive when a capture was truncated (INV-5)", () => {
    const truncated = { ...run(2, "a", 8000), captureTruncated: true };
    const v = aggregate(
      "req-1",
      "m.yaml",
      arm("control", [run(1, "a", 40000), run(2, "a", 40000), run(3, "a", 40000)]),
      arm("lean", [run(1, "a", 8000), truncated, run(3, "a", 8000)]),
      [],
      [],
      ["a"],
    );
    expect(v.hypothesisVerdict).toBe("inconclusive");
    expect("ratio" in v).toBe(false);
    expect(v.errors.some((e) => e.code === "capture_truncated")).toBe(true);
  });
});

describe("preflight — refuse before any spend (INV-5)", () => {
  const env = { OPENROUTER_API_KEY: "sk-or-v1-xxxxxxxxxxxx" };

  it("passes on pinned pi with both flags and a key", () => {
    const res = preflight("0.55.0", HELP, env);
    expect(res.ok).toBe(true);
  });

  it("refuses when either flag is absent", () => {
    expect(preflight("0.55.0", "  --no-skills ...", env).ok).toBe(false);
    expect(preflight("0.55.0", "  --no-extensions ...", env).ok).toBe(false);
  });

  it("refuses an unpinned pi version unless explicitly allowed", () => {
    const blocked = preflight("0.84.1", HELP, env);
    expect(blocked.ok).toBe(false);
    expect(blocked.ok === false && blocked.reason).toContain("0.55.x");
    const allowed = preflight("0.84.1", HELP, {
      ...env,
      QDS_BENCH_ALLOW_PI_VERSION: "1",
    });
    expect(allowed.ok).toBe(true);
    // The deviation is recorded in the artifact, not swallowed.
    expect(allowed.ok === true && allowed.notes.join(" ")).toContain("0.84.1");
  });

  it("refuses with no OpenRouter key rather than running one-armed", () => {
    const res = preflight("0.55.0", HELP, {});
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.reason).toContain("OPENROUTER_API_KEY");
  });
});

describe("manifestForArm — the arms differ only by the lean key", () => {
  const src = `
name: lean-worker-benchmark
team:
  project: qds-factory
  lead:
    agentId: lead
    model: openrouter/m
    prompt: lead
  workers:
    - agentId: worker-a
      model: openrouter/m
      prompt: ack
    - agentId: worker-b
      model: openrouter/m
      prompt: ack
`;

  it("sets lean on every worker for the lean arm", () => {
    const out = manifestForArm(src, "lean");
    expect(out.match(/lean: true/g)).toHaveLength(2);
  });

  it("leaves the control arm with no lean KEY at all (AC3)", () => {
    // The manifest NAME contains "lean", so match the key, not the substring.
    expect(manifestForArm(src, "control")).not.toMatch(/^\s*lean:/m);
  });

  it("strips a lean key already present in the source for the control arm", () => {
    const withLean = src.replace("      prompt: ack\n", "      prompt: ack\n      lean: true\n");
    expect(manifestForArm(withLean, "control")).not.toMatch(/^\s*lean:/m);
    expect(manifestForArm(withLean, "lean").match(/lean: true/g)).toHaveLength(2);
  });

  it("does not touch the lead role", () => {
    const out = manifestForArm(src, "lean");
    const leadBlock = out.slice(out.indexOf("lead:"), out.indexOf("workers:"));
    expect(leadBlock).not.toMatch(/^\s*lean:/m);
  });
});

describe("bench CLI (AC4: a failed measurement exits non-zero)", () => {
  const SC = join(import.meta.dir, "..");

  /**
   * A pi stub on PATH, so these tests do not silently encode "this machine has
   * some particular pi installed globally" — without it they assert different
   * things depending on which pi the host happens to have.
   */
  function stubPiDir(opts: {
    version?: string;
    flags?: boolean;
    task?: number;
    overhead?: number;
  }): string {
    const dir = mkdtempSync(join(tmpdir(), "lean-bench-stub-"));
    const help = opts.flags === false ? "" : "--no-extensions --no-skills";
    writeFileSync(
      join(dir, "pi"),
      [
        "#!/usr/bin/env bun",
        "const argv = process.argv.slice(2);",
        `if (argv.includes("--version")) { console.log(${JSON.stringify(opts.version ?? "0.55.0")}); process.exit(0); }`,
        `if (argv.includes("--help")) { console.log(${JSON.stringify(help)}); process.exit(0); }`,
        'const lean = argv.includes("--no-extensions") && argv.includes("--no-skills");',
        `const input = ${opts.task ?? 8000} + (lean ? 0 : ${opts.overhead ?? 37279});`,
        'const msg = (i, t) => ({ role: "assistant", content: [{ type: "text", text: t }], usage: { input: i, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } });',
        'console.log(JSON.stringify({ type: "message_end", message: msg(input, "one") }));',
        'console.log(JSON.stringify({ type: "message_end", message: msg(input + 5000, JSON.stringify({ changedFiles: [], result: { summary: "ack" } })) }));',
        "process.exit(0);",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    return dir;
  }

  const benchEnv = (
    stub: string,
    extra: Record<string, string> = {},
  ): Record<string, string> => ({
    PATH: `${stub}:${process.env.PATH ?? ""}`,
    HOME: process.env.HOME ?? "/tmp",
    ...extra,
  });

  const runBench = (
    manifest: string,
    env: Record<string, string>,
  ): { status: number | null; stderr: string } => {
    const proc = spawnSync("bun", ["scripts/lean-worker-benchmark.ts", manifest], {
      cwd: SC,
      encoding: "utf8",
      env,
    });
    return { status: proc.status, stderr: proc.stderr ?? "" };
  };

  const KEY = { OPENROUTER_API_KEY: "sk-or-v1-fake000000000000000000" };
  const MANIFEST = "cli-anything/manifests/lean-benchmark.yaml";

  /**
   * A per-test artifacts sink. The bench's default is the REPO'S shared
   * `artifacts/` directory — every story's evidence lands there — so a test
   * that rmSync'd it would destroy real artifacts, and a test asserting the
   * verdict file is absent would fail on any host where an operator had run
   * the bench for real.
   */
  function withArtifactsDir<T>(fn: (dir: string, artifact: string) => T): T {
    const dir = mkdtempSync(join(tmpdir(), "lean-bench-artifacts-"));
    try {
      return fn(dir, join(dir, "lean-worker-benchmark.json"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("exits 2 before any spend when OPENROUTER_API_KEY is unset, writing no artifact", () => {
    const stub = stubPiDir({});
    try {
      withArtifactsDir((dir, artifact) => {
        const r = runBench(MANIFEST, benchEnv(stub, { QDS_BENCH_ARTIFACTS_DIR: dir }));
        expect(r.status).toBe(2);
        expect(r.stderr).toContain("preflight failed");
        expect(r.stderr).toContain("OPENROUTER_API_KEY");
        expect(r.stderr).toContain("Nothing was spent");
        expect(existsSync(artifact)).toBe(false);
      });
    } finally {
      rmSync(stub, { recursive: true, force: true });
    }
  }, 60_000);

  it("exits 2 on an unpinned pi version, before any spend", () => {
    const stub = stubPiDir({ version: "0.84.1" });
    try {
      withArtifactsDir((dir, artifact) => {
        const r = runBench(
          MANIFEST,
          benchEnv(stub, { ...KEY, QDS_BENCH_ARTIFACTS_DIR: dir }),
        );
        expect(r.status).toBe(2);
        expect(r.stderr).toContain("0.55.x");
        expect(existsSync(artifact)).toBe(false);
      });
    } finally {
      rmSync(stub, { recursive: true, force: true });
    }
  }, 60_000);

  it("exits 2 when pi lacks the lean flags, before any spend", () => {
    const stub = stubPiDir({ flags: false });
    try {
      const r = runBench(MANIFEST, benchEnv(stub, KEY));
      expect(r.status).toBe(2);
      expect(r.stderr).toContain("--no-extensions");
    } finally {
      rmSync(stub, { recursive: true, force: true });
    }
  }, 60_000);

  it("exits 2 when the manifest declares no workers", () => {
    const stub = stubPiDir({});
    const dir = mkdtempSync(join(tmpdir(), "lean-bench-noworkers-"));
    try {
      const m = join(dir, "m.yaml");
      writeFileSync(m, "name: x\nteam:\n  project: p\n");
      expect(runBench(m, benchEnv(stub, KEY)).status).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(stub, { recursive: true, force: true });
    }
  }, 60_000);

  it("runs both arms interleaved, measures only workers, and exits 0 (AC1 e2e)", () => {
    // Exercises the LIVE paths no unit test reaches: runIteration, the
    // temp-manifest lifecycle, the lead-exclusion filter (`agentId in models`,
    // which is the real filter — workerAgentIds is tested separately and is
    // NOT what main uses), arm duration accumulation and the artifact write.
    const stub = stubPiDir({});
    try {
      withArtifactsDir((dir, artifact) => {
      const r = runBench(
        MANIFEST,
        benchEnv(stub, { ...KEY, QDS_BENCH_RUNS: "3", QDS_BENCH_ARTIFACTS_DIR: dir }),
      );
      expect(r.status).toBe(0);
      const v = JSON.parse(readFileSync(artifact, "utf8")) as {
        hypothesisVerdict: string;
        ratio?: number;
        deltaTokens?: number;
        arms: Record<
          string,
          { n: number; runs: Array<{ agentId: string; model: string; exitStatus: string }> }
        >;
        iterationOrder?: Array<{ arm: string; iteration: number }>;
        perWorker: Array<{ agentId: string }>;
      };
      expect(v.hypothesisVerdict).toBe("supported");
      expect(v.arms.control?.n).toBe(3);
      expect(v.arms.lean?.n).toBe(3);
      // The LEAD must not be measured — it is never leaned, so averaging its
      // 1.0 ratio in drags the verdict toward "refuted".
      expect(v.perWorker.map((w) => w.agentId).sort()).toEqual(["worker-a", "worker-b"]);
      expect(v.arms.control?.runs.some((x) => x.agentId === "lead")).toBe(false);
      // Real model slugs, not a placeholder (AC1).
      expect(v.arms.control?.runs[0]?.model).toContain("openrouter/");
      // The CC-1 enum, read from the runner's merged output.
      expect(v.arms.control?.runs[0]?.exitStatus).toBe("success");
      // Interleaving is verifiable FROM THE ARTIFACT, not from a prose note.
      expect(v.iterationOrder?.map((e) => e.arm).slice(0, 4)).toEqual([
        "control",
        "lean",
        "control",
        "lean",
      ]);
      expect(v.deltaTokens).toBe(2 * 37279);
      });
    } finally {
      rmSync(stub, { recursive: true, force: true });
    }
  }, 180_000);

  it("exits 1 with inconclusive and no ratio when both arms read zero (AC4)", () => {
    // task=0 and overhead=0 → every first turn reads 0 input tokens in BOTH
    // arms. An implementation that divides anyway emits Infinity or NaN.
    const stub = stubPiDir({ task: 0, overhead: 0 });
    try {
      withArtifactsDir((dir, artifact) => {
        const r = runBench(
          MANIFEST,
          benchEnv(stub, { ...KEY, QDS_BENCH_RUNS: "3", QDS_BENCH_ARTIFACTS_DIR: dir }),
        );
        expect(r.status).toBe(1);
        const v = JSON.parse(readFileSync(artifact, "utf8")) as Record<string, unknown>;
        expect(v.hypothesisVerdict).toBe("inconclusive");
        expect("ratio" in v).toBe(false);
      });
    } finally {
      rmSync(stub, { recursive: true, force: true });
    }
  }, 180_000);
});

describe("mergedExitStatus — the real CC-1 enum, not a collapsed guess", () => {
  it("reads exitStatus out of the runner's merged JSON", () => {
    const statuses = [
      "success",
      "transient",
      "overflow",
      "logic",
      "lead_failure",
    ] as const;
    for (const s of statuses) {
      expect(mergedExitStatus(JSON.stringify({ exitStatus: s }), 0)).toBe(s);
    }
    // An overflow run exits non-zero but is NOT a logic error.
    expect(mergedExitStatus('{"exitStatus":"overflow"}', 1)).toBe("overflow");
  });

  it("falls back conservatively without parseable output", () => {
    expect(mergedExitStatus("", 0)).toBe("success");
    expect(mergedExitStatus("not json", 3)).toBe("logic");
    // status null = killed by our timeout or a signal: transient, not logic.
    expect(mergedExitStatus("", null)).toBe("transient");
    expect(mergedExitStatus("", 0, new Error("ENOENT"))).toBe("transient");
  });
});

describe("workerModels — AC1 records the slugs used", () => {
  it("maps each worker agentId to its manifest model slug", () => {
    const src = `
name: b
team:
  project: p
  lead:
    agentId: lead
    model: openrouter/lead-model
    prompt: lead
  workers:
    - agentId: worker-a
      model: openrouter/openai/gpt-oss-20b:free
      prompt: ack
    - agentId: worker-b
      model: openrouter/nvidia/nemotron-nano-9b-v2:free
      prompt: ack
`;
    expect(workerModels(src)).toEqual({
      "worker-a": "openrouter/openai/gpt-oss-20b:free",
      "worker-b": "openrouter/nvidia/nemotron-nano-9b-v2:free",
    });
    // The lead is not a measured agent and must not appear.
    expect(workerModels(src).lead).toBeUndefined();
  });
});

describe("workerAgentIds — the lead is never measured", () => {
  const src = `
name: b
team:
  project: p
  lead:
    agentId: lead
    model: openrouter/m
    prompt: lead
  workers:
    - agentId: worker-a
      model: openrouter/m
      prompt: ack
    - agentId: worker-b
      model: openrouter/m
      prompt: ack
`;

  it("returns only the worker agentIds", () => {
    // The driver captures the lead's raw stream too, but `lean` is per-worker
    // and the lead is never leaned. Averaging its unchanged 1.0 ratio in drags
    // the result toward "refuted" while the lever worked on every worker —
    // this is the bug the first end-to-end bench run actually produced
    // (overall ratio 4.11 from per-worker ratios of 5.66, 5.66 and 1.0).
    expect(workerAgentIds(src)).toEqual(["worker-a", "worker-b"]);
    expect(workerAgentIds(src)).not.toContain("lead");
  });

  it("returns an empty list for a manifest with no workers", () => {
    expect(workerAgentIds("name: x\nteam:\n  project: p\n")).toEqual([]);
  });
});
