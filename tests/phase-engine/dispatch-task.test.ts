/**
 * Tests for the dispatch_task phase body (Story DF1.6, Task T7).
 *
 * Unit-level: the team runner is injected via _injectRunner (and ALWAYS
 * restored in afterEach — a leaked fake means a later test spawns the real
 * team-lead-driver). Coverage maps to the story DoD: AC5 refusal, key
 * presence, roster gates, AC2 counters, AC3 precedence (incl. negative
 * controls), AC4 empty-bank, AC6 both branches, prompt persistence
 * pre-spawn, INV-2 path validation (incl. intermediate-symlink walk), INV-4
 * redaction, manifest schema.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  symlinkSync,
  unlinkSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import type { PhaseSpec } from "../../src/phase-engine/types.ts";
import type { PhaseBodyContext } from "../../src/phase-engine/phase.ts";
import {
  dispatchTask,
  _injectRunner,
  validateChangedFiles,
  validateArtifacts,
} from "../../src/phase-engine/phases/dispatch-task.ts";
import { runTeamManifest } from "../../cli-anything/src/runner.ts";
import type { TeamRunOptions } from "../../cli-anything/src/runner.ts";
import { parseTeamEventLine } from "../../cli-anything/src/team-events.ts";
import type { MergedOutput } from "../../cli-anything/src/types.ts";
import { PipelineManifestSchema } from "../../src/phase-engine/manifest.ts";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import type { ValidateDeps } from "../../src/phase-engine/roster/validate.ts";

const FIXTURE_ROSTER = join(import.meta.dir, "fixtures", "dispatch-roster.yaml");
const FIXTURE_NDJSON = join(import.meta.dir, "fixtures", "dispatch-task-ndjson.jsonl");

type TraceEntry = {
  requestId: string;
  phaseId?: string;
  type: string;
  name: string;
  payloadJson?: string;
};
let traceLog: TraceEntry[];
let fakeTracer: { trace: (event: TraceEntry) => void };
let tmpRoot: string;

/** Offline dual-gate probes + rate tables: every fixture slug "verified",
 * zero pi spawns, zero host-catalog reads. */
const offlineGate: ValidateDeps = {
  probeCatalog: async () => ({
    ok: true,
    pairs: new Set(["anthropic/claude-haiku-4-5"]),
    durationMs: 0,
  }),
  probeProvider: async () => ({
    ok: true,
    ids: new Set(["claude-haiku-4-5"]),
    durationMs: 0,
  }),
  rateSources: {
    bundled: {
      unit: "usd-per-mtok",
      entries: new Map([["anthropic/claude-haiku-4-5", { input: 1, output: 5 }]]),
    },
    custom: { unit: "usd-per-mtok", entries: new Map() },
  },
};

beforeEach(() => {
  // Absolute (tmpdir) — production QDS_RUN_ROOT is always absolute
  // (pipeline-run uses process.cwd()); Bun.spawn with a RELATIVE cwd does
  // not remap relative argv paths, so a relative root breaks sh <script>.
  tmpRoot = mkdtempSync(join(tmpdir(), "qds-dispatch-test-"));
  process.env.QDS_RUN_ROOT = tmpRoot;
  // biome-ignore lint/performance/noDelete: unset is the semantic — delete removes the key, assignment sets it to "undefined" string.
  delete process.env.QDS_TEAM_RUNNER;
  // biome-ignore lint/performance/noDelete: unset is the semantic — delete removes the key, assignment sets it to "undefined" string.
  delete process.env.ANTHROPIC_API_KEY;
  // biome-ignore lint/performance/noDelete: unset is the semantic — delete removes the key, assignment sets it to "undefined" string.
  delete process.env.OPENROUTER_API_KEY;
  traceLog = [];
  fakeTracer = { trace: (event) => void traceLog.push(event) };
});

afterEach(() => {
  // CRITICAL: a leaked injected runner makes later tests spawn the REAL
  // team-lead-driver. Always restore.
  _injectRunner(runTeamManifest);
  // biome-ignore lint/performance/noDelete: unset is the semantic — delete removes the key, assignment sets it to "undefined" string.
  delete process.env.QDS_RUN_ROOT;
  // biome-ignore lint/performance/noDelete: unset is the semantic — delete removes the key, assignment sets it to "undefined" string.
  delete process.env.QDS_TEAM_RUNNER;
  // biome-ignore lint/performance/noDelete: unset is the semantic — delete removes the key, assignment sets it to "undefined" string.
  delete process.env.ANTHROPIC_API_KEY;
  // biome-ignore lint/performance/noDelete: unset is the semantic — delete removes the key, assignment sets it to "undefined" string.
  delete process.env.OPENROUTER_API_KEY;
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch (e) {
    // best-effort cleanup — warn so orphaned temp dirs are visible
    console.warn(`dispatch-task.test cleanup failed: ${tmpRoot}`, e instanceof Error ? e.message : String(e));
  }
});

function spec(over: Partial<PhaseSpec> = {}): PhaseSpec {
  return {
    name: "dispatch",
    kind: "dispatch_task",
    description: "test dispatch phase",
    maxDurationMs: 60000,
    retries: 0,
    roster: FIXTURE_ROSTER,
    task: "fix the seeded failing test",
    ...over,
  };
}

function createContext(): PhaseBodyContext {
  return {
    signal: new AbortController().signal,
    phaseId: "phase-1",
    params: spec(),
    ctx: { runId: "run-test", pipelineId: "pipeline-test", requestId: "req-test" },
  };
}

type FakeRunner = (
  manifestPath: string,
  opts?: TeamRunOptions,
) => Promise<MergedOutput>;

/** Wire a fake runner; returns a spy the test can assert on. */
function injectFake(
  impl: (opts: TeamRunOptions) => Promise<MergedOutput> | MergedOutput,
): { calls: number } {
  const spy = { calls: 0 };
  _injectRunner(((manifestPath: string, opts?: TeamRunOptions) => {
    spy.calls += 1;
    return impl(opts ?? {});
  }) as FakeRunner);
  return spy;
}

function feedLine(opts: TeamRunOptions, line: string): void {
  const event = parseTeamEventLine(line);
  opts.onTeamEvent?.(event, { droppedOversize: false });
}

function successResult(over: Partial<MergedOutput> = {}): MergedOutput {
  return {
    exitStatus: "success",
    partial: false,
    result: { summary: "done" },
    agentOutputs: {},
    changedFiles: [],
    comsLog: [],
    durationMs: 100,
    waivers: [],
    error: null,
    summary: "done",
    mulchPrimed: false,
    mulchPrimeError: null,
    artifacts: [],
    ...over,
  } as MergedOutput;
}

function runDispatch(
  over: Partial<PhaseSpec> = {},
): Promise<import("../../src/phase-engine/phases/dispatch-task.ts").DispatchTaskValue> {
  return Promise.resolve(
    dispatchTask(spec(over), {
      tracer: fakeTracer as never,
      requestId: "req-test",
      rosterValidateDeps: offlineGate,
    })(createContext()),
  );
}

describe("dispatch-task: AC5 QDS_TEAM_RUNNER refusal", () => {
  it("unset refuses pre-spawn, names the variable, never spawns", async () => {
    // biome-ignore lint/performance/noDelete: unset is the semantic — assignment would leave "undefined" in the env.
    delete process.env.QDS_TEAM_RUNNER;
    const spy = injectFake(() => successResult());
    const result = await runDispatch();
    expect(result.exitStatus).toBe("logic");
    expect(result.error?.message).toContain("QDS_TEAM_RUNNER");
    expect(result.error?.message).toContain("unset");
    expect(spy.calls).toBe(0); // refusal BEFORE any spawn
  });

  it("warren refuses pre-spawn, names the variable", async () => {
    process.env.QDS_TEAM_RUNNER = "warren";
    process.env.ANTHROPIC_API_KEY = "sk-test-key-long-enough";
    const spy = injectFake(() => successResult());
    const result = await runDispatch();
    expect(result.exitStatus).toBe("logic");
    expect(result.error?.message).toContain("QDS_TEAM_RUNNER");
    expect(result.error?.message).toContain("warren");
    expect(spy.calls).toBe(0);
  });
});

describe("dispatch-task: manifest schema refusal", () => {
  it("roster with >3 workers refuses (logic) instead of throwing out of the body", async () => {
    // lead + 4 workers passes the offline dual-gate (which verifies models,
    // not counts) but violates TeamManifestSchema's workers max(3) — the
    // adapter's schema.parse throws, and the phase must translate that into
    // a schema-validated refusal, never a body throw.
    process.env.QDS_TEAM_RUNNER = "local";
    process.env.ANTHROPIC_API_KEY = "sk-test-key-long-enough";
    const lines = [
      "defaults:",
      "  provider: anthropic",
      "  thinking: off",
      "  tools: null",
      "  writes: []",
      "  harness_engineering: []",
      "roles:",
    ];
    for (const name of ["lead", "w1", "w2", "w3", "w4"]) {
      lines.push(`  - name: ${name}`, "    model: claude-haiku-4-5");
    }
    // loadRoster confines rosters to the repo root (tmpRoot is outside it),
    // so this roster must live INSIDE the repo (fixtures dir, cleaned in
    // finally) — otherwise the refusal is the confinement error, not the
    // manifest-schema error this test exists to exercise.
    const rosterPath = join(import.meta.dir, "fixtures", ".tmp-five-worker-roster.yaml");
    writeFileSync(rosterPath, `${lines.join("\n")}\n`);
    let result: Awaited<ReturnType<typeof runDispatch>>;
    try {
      const spy = injectFake(() => successResult());
      result = await runDispatch({ roster: rosterPath });
      expect(spy.calls).toBe(0); // refused BEFORE any spawn
    } finally {
      try {
        unlinkSync(rosterPath);
      } catch (e) {
        // best-effort cleanup — warn so orphaned temp files are visible
        console.warn(`dispatch-task.test cleanup failed: ${rosterPath}`, e instanceof Error ? e.message : String(e));
      }
    }
    expect(result.exitStatus).toBe("logic");
    expect(result.error?.message).toMatch(/at most 3.*element/i);
    // Pin the refusal to the manifest-schema path: the /worker/i match alone
    // once passed VACUOUSLY when the roster sat in tmpRoot — the confinement
    // error echoes the roster path, and the filename contained "worker".
    expect(result.error?.message).not.toContain("outside the repo root");
  });
});

describe("dispatch-task: provider key presence", () => {
  it("missing both keys refuses pre-spawn, names keys by name only", async () => {
    process.env.QDS_TEAM_RUNNER = "local";
    const spy = injectFake(() => successResult());
    const result = await runDispatch();
    expect(result.exitStatus).toBe("logic");
    expect(result.error?.message).toContain("ANTHROPIC_API_KEY");
    expect(result.error?.message).toContain("OPENROUTER_API_KEY");
    expect(spy.calls).toBe(0);
  });
});

describe("dispatch-task: roster gates refuse pre-spawn", () => {
  it("unreadable roster refuses with logic", async () => {
    process.env.QDS_TEAM_RUNNER = "local";
    process.env.ANTHROPIC_API_KEY = "sk-test-key-long-enough";
    const spy = injectFake(() => successResult());
    const result = await runDispatch({ roster: join(tmpRoot, "nope.yaml") });
    expect(result.exitStatus).toBe("logic");
    expect(spy.calls).toBe(0);
  });

  it("single-role roster refuses (needs lead + >=1 worker)", async () => {
    process.env.QDS_TEAM_RUNNER = "local";
    process.env.ANTHROPIC_API_KEY = "sk-test-key-long-enough";
    // loadRoster confines rosters to the repo root, so the one-role variant
    // must live INSIDE the repo (fixtures dir, cleaned in afterEach). Written
    // as an explicit minimal roster — regex-deriving it from the two-role
    // fixture couples this test to that fixture's exact formatting.
    const oneRole = join(import.meta.dir, "fixtures", ".tmp-one-role.yaml");
    writeFileSync(
      oneRole,
      [
        "# Single-role roster: lead only — must refuse (needs >= 1 worker).",
        "defaults:",
        "  provider: anthropic",
        "  thinking: off",
        "  tools: null",
        "  writes: []",
        "  harness_engineering: []",
        "",
        "roles:",
        "  - name: lead",
        "    model: claude-haiku-4-5",
        "",
      ].join("\n"),
    );
    try {
      const result = await runDispatch({ roster: oneRole });
      expect(result.exitStatus).toBe("logic");
      expect(result.error?.message).toContain("lead role");
    } finally {
      try {
        unlinkSync(oneRole);
      } catch (e) {
        // best-effort cleanup — warn so orphaned temp files are visible
        console.warn(`dispatch-task.test cleanup failed: ${oneRole}`, e instanceof Error ? e.message : String(e));
      }
    }
  });
});

describe("dispatch-task: AC2 stream counters", () => {
  it("malformed and dropped are distinct counters", async () => {
    process.env.QDS_TEAM_RUNNER = "local";
    process.env.ANTHROPIC_API_KEY = "sk-test-key-long-enough";
    injectFake((opts) => {
      opts.onTeamEvent?.(null, { droppedOversize: false }); // malformed
      opts.onTeamEvent?.(null, { droppedOversize: true }); // cap-dropped
      opts.onRunFacts?.({
        exitCode: 0,
        termSignal: null,
        killOrigin: null,
        comsInitError: null,
      });
      return successResult();
    });
    const result = await runDispatch();
    expect(result.malformedLines).toBe(1);
    expect(result.droppedOversizeLines).toBe(1);
  });

  it("clean 12-line fixture stream reports zeros", async () => {
    process.env.QDS_TEAM_RUNNER = "local";
    process.env.ANTHROPIC_API_KEY = "sk-test-key-long-enough";
    injectFake((opts) => {
      for (const line of readFileSync(FIXTURE_NDJSON, "utf8").trim().split("\n")) {
        feedLine(opts, line);
      }
      opts.onRunFacts?.({
        exitCode: 0,
        termSignal: null,
        killOrigin: null,
        comsInitError: null,
      });
      return successResult({ changedFiles: ["cli-anything/src/redact.ts"] });
    });
    const result = await runDispatch();
    expect(result.malformedLines).toBe(0);
    expect(result.droppedOversizeLines).toBe(0);
  });
});

describe("dispatch-task: AC3 precedence rule", () => {
  function armed(): void {
    process.env.QDS_TEAM_RUNNER = "local";
    process.env.ANTHROPIC_API_KEY = "sk-test-key-long-enough";
  }

  it("watchdog kill, no merged -> overflow with partialOutput (negative control: envelope-first fails)", async () => {
    armed();
    injectFake((opts) => {
      opts.onRunFacts?.({
        exitCode: null,
        termSignal: "SIGKILL",
        killOrigin: "watchdog",
        comsInitError: null,
      });
      return successResult({ partialOutput: "partial work before kill" });
    });
    const result = await runDispatch();
    expect(result.exitStatus).toBe("overflow");
    expect(result.partialOutput).toBeTruthy();
  });

  it("coms_init_error -> transient, ahead of everything", async () => {
    armed();
    injectFake((opts) => {
      feedLine(opts, '{"type":"coms_init_error","reason":"coms layer never came up"}');
      opts.onRunFacts?.({
        exitCode: 1,
        termSignal: null,
        killOrigin: null,
        comsInitError: "coms layer never came up",
      });
      return successResult({ exitStatus: "transient" });
    });
    const result = await runDispatch();
    expect(result.exitStatus).toBe("transient");
  });

  it("exit 0, no merged -> lead_failure (including exit code 0)", async () => {
    armed();
    injectFake((opts) => {
      opts.onRunFacts?.({
        exitCode: 0,
        termSignal: null,
        killOrigin: null,
        comsInitError: null,
      });
      return successResult({ result: {} });
    });
    const result = await runDispatch();
    expect(result.exitStatus).toBe("lead_failure");
  });

  it("exit 64 -> logic unconditionally (driver config error)", async () => {
    armed();
    injectFake((opts) => {
      feedLine(
        opts,
        '{"type":"merged","result":{"summary":"should not save an exit-64 run"}}',
      );
      opts.onRunFacts?.({
        exitCode: 64,
        termSignal: null,
        killOrigin: null,
        comsInitError: null,
      });
      return successResult();
    });
    const result = await runDispatch();
    expect(result.exitStatus).toBe("logic");
  });

  it("exit 0 + valid merged -> success", async () => {
    armed();
    injectFake((opts) => {
      feedLine(opts, '{"type":"merged","result":{"summary":"clean run"}}');
      opts.onRunFacts?.({
        exitCode: 0,
        termSignal: null,
        killOrigin: null,
        comsInitError: null,
      });
      return successResult({ changedFiles: ["src/a.ts"] });
    });
    const result = await runDispatch();
    expect(result.exitStatus).toBe("success");
  });

  it("unknown-origin signal -> transient", async () => {
    armed();
    injectFake((opts) => {
      opts.onRunFacts?.({
        exitCode: null,
        termSignal: "SIGKILL",
        killOrigin: null,
        comsInitError: null,
      });
      return successResult({ partialOutput: "kernel oom suspicion" });
    });
    const result = await runDispatch();
    expect(result.exitStatus).toBe("transient");
  });
});

describe("dispatch-task: round-6 hardening", () => {
  it("duplicate merged event: first wins, warns once per duplicate", async () => {
    process.env.QDS_TEAM_RUNNER = "local";
    process.env.ANTHROPIC_API_KEY = "sk-test-key-long-enough";
    const warns: string[] = [];
    const origWarn = console.warn;
    console.warn = (msg?: unknown) => {
      warns.push(String(msg));
    };
    try {
      injectFake((opts) => {
        feedLine(opts, '{"type":"merged","result":{"summary":"first"}}');
        feedLine(opts, '{"type":"merged","result":{"summary":"second"}}');
        opts.onRunFacts?.({
          exitCode: 0,
          termSignal: null,
          killOrigin: null,
          comsInitError: null,
        });
        return successResult();
      });
      const result = await runDispatch();
      expect(result.exitStatus).toBe("success");
      expect(warns.filter((w) => w.includes("duplicate merged"))).toHaveLength(1);
    } finally {
      console.warn = origWarn;
    }
  });

  it("runner throws: manifest file cleaned up despite the throw", async () => {
    process.env.QDS_TEAM_RUNNER = "local";
    process.env.ANTHROPIC_API_KEY = "sk-test-key-long-enough";
    injectFake(() => {
      throw new Error("runner exploded");
    });
    await expect(runDispatch()).rejects.toThrow("runner exploded");
    const dir = join(tmpRoot, ".qds-manifests");
    const leftover = existsSync(dir) ? readdirSync(dir).length : 0;
    expect(leftover).toBe(0);
  });
});

describe("dispatch-task: AC4 empty bank", () => {
  it("no priming integration -> mulchPrimed false and success", async () => {
    process.env.QDS_TEAM_RUNNER = "local";
    process.env.ANTHROPIC_API_KEY = "sk-test-key-long-enough";
    injectFake((opts) => {
      feedLine(opts, '{"type":"merged","result":{"summary":"ok"}}');
      opts.onRunFacts?.({
        exitCode: 0,
        termSignal: null,
        killOrigin: null,
        comsInitError: null,
      });
      return successResult();
    });
    const result = await runDispatch();
    expect(result.exitStatus).toBe("success");
    expect(result).toHaveProperty("mulchPrimed", false);
  });
});

describe("dispatch-task: AC6 testCommand", () => {
  function writeTestScript(): string {
    const script = join(tmpRoot, "fake-test.sh");
    writeFileSync(
      script,
      '#!/bin/sh\necho " 7 pass"\necho " 2 fail"\necho "Ran 9 tests across 1 file."\n',
      { mode: 0o755 },
    );
    return script;
  }

  it("declared testCommand runs engine-side, parsed counts land on output", async () => {
    process.env.QDS_TEAM_RUNNER = "local";
    process.env.ANTHROPIC_API_KEY = "sk-test-key-long-enough";
    const script = writeTestScript();
    injectFake((opts) => {
      opts.onRunFacts?.({
        exitCode: 0,
        termSignal: null,
        killOrigin: null,
        comsInitError: null,
      });
      return successResult();
    });
    const result = await runDispatch({ testCommand: ["sh", script] });
    expect(result.testResults).toEqual({ passed: 7, failed: 2 });
    expect(result.testsExecuted).toBe(true);
  });

  it("no testCommand -> {0,0}, testsExecuted false, no test spawn", async () => {
    process.env.QDS_TEAM_RUNNER = "local";
    process.env.ANTHROPIC_API_KEY = "sk-test-key-long-enough";
    const script = writeTestScript();
    injectFake((opts) => {
      opts.onRunFacts?.({
        exitCode: 0,
        termSignal: null,
        killOrigin: null,
        comsInitError: null,
      });
      return successResult();
    });
    const result = await runDispatch(); // script exists but is NOT declared
    expect(result.testResults).toEqual({ passed: 0, failed: 0 });
    expect(result.testsExecuted).toBe(false);
  });

  it("worker_output claiming test results never feeds testResults", async () => {
    process.env.QDS_TEAM_RUNNER = "local";
    process.env.ANTHROPIC_API_KEY = "sk-test-key-long-enough";
    injectFake((opts) => {
      feedLine(
        opts,
        '{"type":"worker_output","agentId":"lead","output":{"summary":"tests all passed","testResults":{"passed":99,"failed":0}}}',
      );
      feedLine(opts, '{"type":"merged","result":{"summary":"claims 99 pass"}}');
      opts.onRunFacts?.({
        exitCode: 0,
        termSignal: null,
        killOrigin: null,
        comsInitError: null,
      });
      return successResult();
    });
    const result = await runDispatch(); // no testCommand declared
    expect(result.testResults).toEqual({ passed: 0, failed: 0 }); // agent claim ignored
    expect(result.testsExecuted).toBe(false);
  });
});

describe("dispatch-task: prompt persistence pre-spawn (XC)", () => {
  it("every role's prompt traced BEFORE the runner is invoked", async () => {
    process.env.QDS_TEAM_RUNNER = "local";
    process.env.ANTHROPIC_API_KEY = "sk-test-key-long-enough";
    let promptsAtSpawn = -1;
    injectFake(() => {
      promptsAtSpawn = traceLog.filter((t) => t.type === "prompt").length;
      return successResult();
    });
    await runDispatch();
    expect(promptsAtSpawn).toBe(2); // lead + worker, both BEFORE spawn
    const names = traceLog
      .filter((t) => t.type === "prompt")
      .map((t) => t.name)
      .sort();
    expect(names).toEqual(["lead", "worker"]);
  });

  it("run killed mid-phase still shows prompts (runner throws)", async () => {
    process.env.QDS_TEAM_RUNNER = "local";
    process.env.ANTHROPIC_API_KEY = "sk-test-key-long-enough";
    injectFake(() => {
      throw new Error("SIGKILL mid-phase");
    });
    await runDispatch().catch(() => undefined); // phase engine owns the rejection
    const prompts = traceLog.filter((t) => t.type === "prompt");
    expect(prompts.length).toBe(2); // present though the phase never completed
  });
});

describe("dispatch-task: INV-2 path validation", () => {
  it("changedFiles: two-stage decode-then-check filters traversals", () => {
    const valid = validateChangedFiles([
      "ok.ts",
      "../escape.ts",
      "%2e%2e/traverse.ts",
      "%252e%2e/double.ts",
      "/abs/path.ts",
      "a/../../b.ts",
    ]);
    expect(valid).toEqual(["ok.ts"]);
  });

  it("artifacts: intermediate-symlink traversal rejected by beneath-root walk, not O_NOFOLLOW", () => {
    // System tmpdir, NOT cwd: a bare prefix makes mkdtempSync create the
    // directory relative to the process cwd (the repo root).
    const outside = mkdtempSync(join(tmpdir(), "qds-outside-"));
    try {
      const realFile = join(tmpRoot, "real.txt");
      writeFileSync(realFile, "legit");
      // legit-dir/ contains the artifact; attacker swaps legit-dir -> outside
      const legitDir = join(tmpRoot, "legit-dir");
      mkdirSync(legitDir);
      writeFileSync(join(legitDir, "artifact.txt"), "artifact");
      const outsideFile = join(outside, "evil.txt");
      writeFileSync(outsideFile, "evil");
      const linkedDir = join(tmpRoot, "linked-dir");
      symlinkSync(outside, linkedDir);

      const artifacts = [
        { name: "real", path: "real.txt" },
        { name: "legit", path: "legit-dir/artifact.txt" },
        // intermediate component is a symlink pointing OUTSIDE the root
        { name: "evil", path: "linked-dir/evil.txt" },
      ];
      const valid = validateArtifacts(artifacts, tmpRoot);
      const names = valid.map((a: { name: string }) => a.name).sort();
      expect(names).toEqual(["legit", "real"]); // evil dropped by the WALK
      expect(names).not.toContain("evil");
      // Assert CONTENT of each validated artifact, not just names — a regression
      // that reads a different file or empty content will fail.
      for (const a of valid) {
        const content = readFileSync(join(tmpRoot, a.path), "utf-8");
        if (a.name === "real") expect(content).toBe("legit"); // real.txt contains "legit"
        if (a.name === "legit") expect(content).toBe("artifact"); // artifact.txt contains "artifact"
      }
    } finally {
      try {
        rmSync(outside, { recursive: true, force: true });
      } catch (e) {
        // best-effort cleanup — warn so orphaned temp dirs are visible
        console.warn(`dispatch-task.test cleanup failed: ${outside}`, e instanceof Error ? e.message : String(e));
      }
    }
  });
});

describe("dispatch-task: INV-4 redaction at adapter boundary", () => {
  it("key echoed in summary/partialOutput/artifact name carries marker, zero key chars", async () => {
    const secretKey = "sk-ant-0123456789abcdef-long-enough-min-len";
    process.env.QDS_TEAM_RUNNER = "local";
    process.env.ANTHROPIC_API_KEY = secretKey;
    injectFake(() =>
      successResult({
        // top-level summary is copied up from result.summary — the secret must
        // ride THERE to prove the copy-up path redacts too
        result: { summary: `run used ${secretKey} everywhere` },
        partialOutput: `partial with ${secretKey}`,
        changedFiles: ["src/a.ts"],
        artifacts: [{ name: `${secretKey}.txt`, path: "src/a.ts" }],
      }),
    );
    const result = await runDispatch();
    expect(result.summary).not.toContain(secretKey);
    expect(result.summary).toContain("REDACTED:");
    expect(result.partialOutput ?? "").not.toContain(secretKey);
    const artifactNames = (result.artifacts ?? []).map((a) => a.name).join(" ");
    expect(artifactNames).not.toContain(secretKey);
  });

  it("changedFiles path embedding secret is redacted (validateChangedFiles + redactSecrets)", async () => {
    // validateChangedFiles rejects malformed paths but passes through
    // plausible paths; redactSecrets then scans the output and redacts
    // any secret-looking substrings. A path like "src/secret-sk-ant.ts"
    // survives validation but gets redacted.
    const secretKey = "sk-ant-secret-val-redaction-test-key";
    process.env.QDS_TEAM_RUNNER = "local";
    process.env.ANTHROPIC_API_KEY = secretKey;
    injectFake((opts) => {
      feedLine(opts, '{"type":"merged","result":{"summary":"ok"}}');
      opts.onRunFacts?.({
        exitCode: 0,
        termSignal: null,
        killOrigin: null,
        comsInitError: null,
      });
      return successResult({
        result: { summary: "ok" },
        // Path embeds secret — validateChangedFiles passes it (safe chars),
        // redactSecrets must redact the secret substring.
        changedFiles: [`src/auth/${secretKey}.ts`, "src/normal.ts"],
      });
    });
    const result = await runDispatch();
    const joined = result.changedFiles.join(" ");
    expect(joined).not.toContain(secretKey);
    expect(joined).toContain("REDACTED:");
    // Normal file unchanged
    expect(result.changedFiles).toContain("src/normal.ts");
  });

  it("prompt payload is redacted before persisting", async () => {
    const secretKey = "sk-ant-0123456789abcdef-long-enough-min-len";
    process.env.QDS_TEAM_RUNNER = "local";
    process.env.ANTHROPIC_API_KEY = secretKey;
    injectFake(() => successResult());
    await runDispatch({ task: `leak ${secretKey} in the brief` });
    const promptJson = traceLog
      .filter((t) => t.type === "prompt")
      .map((t) => t.payloadJson ?? "")
      .join(" ");
    expect(promptJson).not.toContain(secretKey);
    expect(promptJson).toContain("REDACTED:");
  });
});

describe("dispatch-task: manifest schema (kind registration)", () => {
  const base = {
    version: "1.0.0",
    pipelineId: "p1",
    runBudgetMs: 1000,
  };
  const twoPhases = (dispatchPhase: Record<string, unknown>): unknown => ({
    ...base,
    phases: [
      { name: "d", kind: "dispatch_task", description: "x", ...dispatchPhase },
      { name: "tail", kind: "engineer", description: "y" },
    ],
  });
  it("accepts dispatch_task with roster+task+testCommand", () => {
    const m = twoPhases({
      roster: "config/rosters/qds-default.roster.yaml",
      task: "do it",
      testCommand: ["bun", "test"],
    });
    expect(PipelineManifestSchema.safeParse(m).success).toBe(true);
  });
  it("rejects dispatch_task missing roster or task", () => {
    const noRoster = twoPhases({ task: "t" });
    expect(PipelineManifestSchema.safeParse(noRoster).success).toBe(false);
    const noTask = twoPhases({ roster: "r.yaml" });
    expect(PipelineManifestSchema.safeParse(noTask).success).toBe(false);
  });
  it("rejects engineer kind carrying roster", () => {
    const m = {
      ...base,
      phases: [
        { name: "e", kind: "engineer", description: "x", roster: "r.yaml", task: "t" },
        { name: "tail", kind: "engineer", description: "y" },
      ],
    };
    expect(PipelineManifestSchema.safeParse(m).success).toBe(false);
  });
});
