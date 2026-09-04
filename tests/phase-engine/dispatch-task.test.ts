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
import { describe, it, test, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  symlinkSync,
  unlinkSync,
  existsSync,
} from "node:fs";
import * as nodeFs from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { PhaseSpec } from "../../src/phase-engine/types.ts";
import type { PhaseBodyContext } from "../../src/phase-engine/phase.ts";
import {
  dispatchTask,
  _injectRunner,
  validateChangedFiles,
  validateArtifacts,
  type DispatchTaskDeps,
} from "../../src/phase-engine/phases/dispatch-task.ts";
import { FileJournal, Run } from "../../src/phase-engine/index.ts";
import { readJournal } from "./journal-test-util.ts";
import { runTeamManifest, type TeamRunOptions } from "../../cli-anything/src/runner.ts";
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
let savedQdsRunRoot: string | undefined;
let savedQdsTeamRunner: string | undefined;
let savedAnthropicKey: string | undefined;
let savedOpenrouterKey: string | undefined;

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
  // Snapshot prior env values (undefined vs "" vs set) so we restore exactly
  savedQdsRunRoot = process.env.QDS_RUN_ROOT;
  savedQdsTeamRunner = process.env.QDS_TEAM_RUNNER;
  savedAnthropicKey = process.env.ANTHROPIC_API_KEY;
  savedOpenrouterKey = process.env.OPENROUTER_API_KEY;

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

  // Restore env vars exactly (undefined→delete, ""→"", value→assign)
  // biome-ignore lint/performance/noDelete: delete is the only way to unset an env var
  if (savedQdsRunRoot === undefined) delete process.env.QDS_RUN_ROOT;
  else process.env.QDS_RUN_ROOT = savedQdsRunRoot;
  // biome-ignore lint/performance/noDelete: delete is the only way to unset an env var
  if (savedQdsTeamRunner === undefined) delete process.env.QDS_TEAM_RUNNER;
  else process.env.QDS_TEAM_RUNNER = savedQdsTeamRunner;
  // biome-ignore lint/performance/noDelete: delete is the only way to unset an env var
  if (savedAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedAnthropicKey;
  // biome-ignore lint/performance/noDelete: delete is the only way to unset an env var
  if (savedOpenrouterKey === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = savedOpenrouterKey;

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

/** Wire a fake runner; returns a spy the test can assert on. */
function injectFake(
  impl: (opts: TeamRunOptions) => Promise<MergedOutput> | MergedOutput,
): { calls: number } {
  const spy = { calls: 0 };
  // Use 'satisfies' to enforce signature match at compile time — drift fails compilation
  _injectRunner(((_manifestPath: string, opts?: TeamRunOptions) => {
    spy.calls += 1;
    const result = impl(opts ?? {});
    return result instanceof Promise ? result : Promise.resolve(result);
  }) satisfies typeof runTeamManifest);
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
  depsOver: Partial<
    import("../../src/phase-engine/phases/dispatch-task.ts").DispatchTaskDeps
  > = {},
): Promise<import("../../src/phase-engine/phases/dispatch-task.ts").DispatchTaskValue> {
  return Promise.resolve(
    dispatchTask(spec(over), {
      tracer: fakeTracer as never,
      requestId: "req-test",
      rosterValidateDeps: offlineGate,
      ...depsOver,
    })(createContext()),
  );
}

describe("dispatch-task: AC5 QDS_TEAM_RUNNER refusal", () => {
  it("empty QDS_RUN_ROOT refuses pre-spawn with logic status, zero spawns", async () => {
    process.env.QDS_TEAM_RUNNER = "local"; // must be valid to hit the runRoot check
    process.env.ANTHROPIC_API_KEY = "sk-test-key-long-enough";
    process.env.QDS_RUN_ROOT = ""; // S2: empty string triggers early refusal
    const spy = injectFake(() => successResult());
    const result = await runDispatch();
    expect(result.exitStatus).toBe("logic");
    expect(result.error?.message).toBe("QDS_RUN_ROOT is empty (use unset or a non-empty path)");
    expect(spy.calls).toBe(0); // refusal BEFORE any spawn
  });

  it("whitespace-only QDS_RUN_ROOT refuses pre-spawn with logic status, zero spawns", async () => {
    process.env.QDS_TEAM_RUNNER = "local"; // must be valid to hit the runRoot check
    process.env.ANTHROPIC_API_KEY = "sk-test-key-long-enough";
    process.env.QDS_RUN_ROOT = "   \t  "; // whitespace-only triggers refusal
    const spy = injectFake(() => successResult());
    const result = await runDispatch();
    expect(result.exitStatus).toBe("logic");
    expect(result.error?.message).toBe("QDS_RUN_ROOT is empty (use unset or a non-empty path)");
    expect(spy.calls).toBe(0); // refusal BEFORE any spawn
  });

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

describe("dispatch-task: manifest directory creation failure", () => {
  it("manifest directory blocked by file refuses with logic, zero spawns", async () => {
    process.env.QDS_TEAM_RUNNER = "local";
    process.env.ANTHROPIC_API_KEY = "sk-test-key-long-enough";
    // Block .qds-manifests directory creation by placing a file at that path
    const manifestDir = join(tmpRoot, ".qds-manifests");
    writeFileSync(manifestDir, "this is a file, not a directory");
    const spy = injectFake(() => successResult());
    const result = await runDispatch();
    expect(result.exitStatus).toBe("logic");
    expect(result.error?.message).toMatch(/manifest directory/i);
    expect(spy.calls).toBe(0); // refused BEFORE any spawn
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
    // ponytail: write to per-test temp path inside fixtures (collision-safe via timestamp)
    const rosterPath = join(import.meta.dir, "fixtures", `.tmp-five-worker-${Date.now()}.yaml`);
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
    // Semantic assertion (not Zod phrasing pinning): message mentions worker/cap/3
    expect(result.error?.message).toMatch(/(worker|cap|maximum|at most)/i);
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

  it("empty-string API key refuses pre-spawn (not counted as present)", async () => {
    process.env.QDS_TEAM_RUNNER = "local";
    process.env.ANTHROPIC_API_KEY = ""; // empty string, not a valid key
    const spy = injectFake(() => successResult());
    const result = await runDispatch();
    expect(result.exitStatus).toBe("logic");
    expect(result.error?.message).toContain("ANTHROPIC_API_KEY");
    expect(result.error?.message).toContain("OPENROUTER_API_KEY");
    expect(spy.calls).toBe(0);
  });

  it("whitespace-only API key refuses pre-spawn (not counted as present)", async () => {
    process.env.QDS_TEAM_RUNNER = "local";
    process.env.ANTHROPIC_API_KEY = "   \t  "; // whitespace-only, not a valid key
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
    // ponytail: write to per-test temp path inside fixtures (collision-safe via timestamp)
    const oneRole = join(import.meta.dir, "fixtures", `.tmp-one-role-${Date.now()}.yaml`);
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
      return successResult({ partialOutput: "partial work before kill", partial: true });
    });
    const result = await runDispatch();
    expect(result.exitStatus).toBe("overflow");
    expect(result.partialOutput).toBeTruthy();
    expect(result.partial).toBe(true); // assert partial===true (not just truthy output)
  });

  it("coms_init_error -> transient, ahead of everything (fake returns success, onRunFacts drives classification)", async () => {
    armed();
    injectFake((opts) => {
      feedLine(opts, '{"type":"coms_init_error","reason":"coms layer never came up"}');
      opts.onRunFacts?.({
        exitCode: 1,
        termSignal: null,
        killOrigin: null,
        comsInitError: "coms layer never came up",
      });
      // ponytail: return success-shaped result (not transient) — prove that onRunFacts
      // comsInitError alone drives the transient classification, not a pass-through verdict.
      return successResult({ exitStatus: "success" });
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
  it("invalid durationMs values clamp to zero with a structured log line", async () => {
    process.env.QDS_TEAM_RUNNER = "local";
    process.env.ANTHROPIC_API_KEY = "sk-test-key-long-enough";
    const lines: Record<string, unknown>[] = [];
    injectFake(() => successResult({ durationMs: Number.POSITIVE_INFINITY }));
    const result = await runDispatch({}, { log: (l) => lines.push(l) });
    expect(result.durationMs).toBe(0);
    // At least one warn about invalid durationMs
    expect(
      lines.some(
        (l) => typeof l.message === "string" && l.message.includes("durationMs"),
      ),
    ).toBe(true);
  });

  it("duplicate merged event: first wins, warns once per duplicate, asserts surfaced summary is FIRST", async () => {
    process.env.QDS_TEAM_RUNNER = "local";
    process.env.ANTHROPIC_API_KEY = "sk-test-key-long-enough";
    const lines: Record<string, unknown>[] = [];
    injectFake((opts) => {
      feedLine(opts, '{"type":"merged","result":{"summary":"first"}}');
      feedLine(opts, '{"type":"merged","result":{"summary":"second"}}');
      opts.onRunFacts?.({
        exitCode: 0,
        termSignal: null,
        killOrigin: null,
        comsInitError: null,
      });
      // Return the summary that the adapter surfaced from the FIRST merged event
      return successResult({ result: { summary: "first" }, summary: "first" });
    });
    const result = await runDispatch({}, { log: (l) => lines.push(l) });
    expect(result.exitStatus).toBe("success");
    expect(result.summary).toBe("first"); // FIRST summary surfaces, not second
    expect(
      lines.filter(
        (l) => typeof l.message === "string" && l.message.includes("duplicate merged"),
      ),
    ).toHaveLength(1);
  });

  it("runner throws: manifest file cleaned up despite the throw (proves write then cleanup)", async () => {
    process.env.QDS_TEAM_RUNNER = "local";
    process.env.ANTHROPIC_API_KEY = "sk-test-key-long-enough";
    injectFake(() => {
      throw new Error("runner exploded");
    });
    // ponytail: can't spy on writeFileSync in ES modules (readonly import)
    // Verify cleanup by checking no manifests leaked in the directory
    const { readdirSync, existsSync: checkExists } = await import("node:fs");
    const runRoot = process.env.QDS_RUN_ROOT ?? join(tmpdir(), ".qds-run-XXXXXX");
    const manifestDir = join(runRoot, ".qds-manifests");
    const manifestsBefore = checkExists(manifestDir) ? readdirSync(manifestDir) : [];
    const beforeCount = manifestsBefore.length;
    try {
      await expect(runDispatch()).rejects.toThrow("runner exploded");
    } finally {
      // Check no new manifests leaked
      const manifestsAfter = checkExists(manifestDir) ? readdirSync(manifestDir) : [];
      expect(manifestsAfter.length).toBe(beforeCount);
    }
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

  it("no testCommand -> {0,0}, testsExecuted false, testCommand never spawned (marker file absent)", async () => {
    process.env.QDS_TEAM_RUNNER = "local";
    process.env.ANTHROPIC_API_KEY = "sk-test-key-long-enough";
    // Script writes a marker file when it runs; we assert it's absent after
    const markerFile = join(tmpRoot, "test-ran-marker.txt");
    const markerScript = join(tmpRoot, "marker-test.sh");
    writeFileSync(
      markerScript,
      `#!/bin/sh\ntouch "${markerFile}"\necho " 7 pass"\necho " 0 fail"\n`,
      { mode: 0o755 },
    );
    injectFake((opts) => {
      opts.onRunFacts?.({
        exitCode: 0,
        termSignal: null,
        killOrigin: null,
        comsInitError: null,
      });
      return successResult();
    });
    const result = await runDispatch(); // markerScript exists but is NOT declared
    expect(result.testResults).toEqual({ passed: 0, failed: 0 });
    expect(result.testsExecuted).toBe(false);
    // Assert marker was never created (script never ran)
    expect(existsSync(markerFile)).toBe(false);
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

  it("declared testCommand exits non-zero → failed counts parsed, classification success-per-contract", async () => {
    process.env.QDS_TEAM_RUNNER = "local";
    process.env.ANTHROPIC_API_KEY = "sk-test-key-long-enough";
    const script = writeTestScript();
    injectFake((opts) => {
      feedLine(opts, '{"type":"merged","result":{"summary":"ok"}}');
      opts.onRunFacts?.({
        exitCode: 1, // Non-zero exit from test runner
        termSignal: null,
        killOrigin: null,
        comsInitError: null,
      });
      return successResult(); // exitStatus=success from runner
    });
    const result = await runDispatch({ testCommand: ["sh", script] });
    // testResult carries parsed counts (2 failed)
    expect(result.testResults).toEqual({ passed: 7, failed: 2 });
    expect(result.testsExecuted).toBe(true);
    // Classification follows precedence rule: exit 0 + valid merged → success
    // (runner's success verdict is NOT overridden by testCommand exit code)
    expect(result.exitStatus).toBe("success");
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

  it("empty changedFiles: [] from merged event surfaces as [] on step output", async () => {
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
      return successResult({ changedFiles: [] });
    });
    const result = await runDispatch();
    expect(result.exitStatus).toBe("success");
    expect(result.changedFiles).toEqual([]);
  });

  it("multiple oversize lines (>1 MiB each) dropped → droppedOversizeLines accumulates", async () => {
    process.env.QDS_TEAM_RUNNER = "local";
    process.env.ANTHROPIC_API_KEY = "sk-test-key-long-enough";
    injectFake((opts) => {
      // Two separate oversize line drops
      opts.onTeamEvent?.(null, { droppedOversize: true });
      opts.onTeamEvent?.(null, { droppedOversize: true });
      opts.onRunFacts?.({
        exitCode: 0,
        termSignal: null,
        killOrigin: null,
        comsInitError: null,
      });
      return successResult();
    });
    const result = await runDispatch();
    expect(result.droppedOversizeLines).toBe(2);
    expect(result.malformedLines).toBe(0);
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
  test.skipIf(process.platform === "win32")("changedFiles: two-stage decode-then-check filters traversals", () => {
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

  test.skipIf(process.platform === "win32")("artifacts: intermediate-symlink traversal rejected by beneath-root walk, not O_NOFOLLOW", () => {
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

  // F060: the beneath-root WALK is the validation — the file body is not.
  // validateArtifacts discarded the bytes it paid to read, so a run with N
  // artifacts moved up to N MiB through the heap to answer a yes/no question.
  test("artifacts: validation resolves the path without reading the body (F060)", () => {
    const big = join(tmpRoot, "big.bin");
    // 512 KiB — under MANIFEST_MAX_BYTES, so the artifact VALIDATES; the point
    // is that none of those bytes are read to say so.
    writeFileSync(big, Buffer.alloc(512 * 1024, 0x61));
    const spy = spyOn(nodeFs, "readFileSync");
    try {
      const valid = validateArtifacts([{ name: "big", path: "big.bin" }], tmpRoot);
      expect(valid.map((a) => a.name)).toEqual(["big"]);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("dispatch-task: INV-4 redaction at adapter boundary", () => {
  it("key echoed in summary/partialOutput/artifact name carries marker, zero key chars (artifact NAME contains key)", async () => {
    const secretKey = "sk-ant-0123456789abcdef-long-enough-min-len";
    process.env.QDS_TEAM_RUNNER = "local";
    process.env.ANTHROPIC_API_KEY = secretKey;
    // Create artifact files for validateArtifacts to read
    mkdirSync(join(tmpRoot, "src"), { recursive: true });
    writeFileSync(join(tmpRoot, "src", "a.ts"), "safe artifact content");
    writeFileSync(join(tmpRoot, "src", "b.ts"), "artifact with secret in name");
    injectFake(() =>
      successResult({
        // top-level summary is copied up from result.summary — the secret must
        // ride THERE to prove the copy-up path redacts too
        result: { summary: `run used ${secretKey} everywhere` },
        partialOutput: `partial with ${secretKey}`,
        changedFiles: ["src/a.ts"],
        // Artifact NAME embeds the secret — redactSecrets must catch it
        artifacts: [
          { name: "safe-artifact.txt", path: "src/a.ts" },
          { name: `${secretKey}-artifact.txt`, path: "src/b.ts" },
        ],
      }),
    );
    const result = await runDispatch();
    expect(result.summary).not.toContain(secretKey);
    expect(result.summary).toContain("REDACTED:");
    expect(result.partialOutput ?? "").not.toContain(secretKey);
    // Assert at least one artifact surfaced (not dropped entirely)
    expect(result.artifacts).toHaveLength(2);
    const artifactNames = (result.artifacts ?? []).map((a) => a.name).join(" ");
    expect(artifactNames).not.toContain(secretKey);
    // Safe artifact found by name
    const safeArtifact = (result.artifacts ?? []).find((a) => a.name === "safe-artifact.txt");
    expect(safeArtifact?.name).toBe("safe-artifact.txt");
    // Secret-containing name carries REDACTED marker, found by REDACTED prefix
    const redactedArtifact = (result.artifacts ?? []).find((a) => a.name.includes("REDACTED:"));
    expect(redactedArtifact?.name).toContain("REDACTED:");
    expect(redactedArtifact?.name).not.toContain(secretKey);
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
      // An inert second phase: the schema needs two, and every assertion in
      // this block is about the dispatch_task phase ahead of it.
      { name: "tail", kind: "code", command: ["true"], description: "y" },
    ],
  });
  it("rejects dispatch_task carrying testCommand (gates compose on kind 'code' only)", () => {
    const m = twoPhases({
      roster: "config/rosters/qds-default.roster.yaml",
      task: "do it",
      testCommand: ["bun", "test"],
    });
    const result = PipelineManifestSchema.safeParse(m);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((i) => i.message).join("; ")).toContain(
        "testCommand is forbidden when kind is 'dispatch_task'",
      );
    }
  });
  it("rejects dispatch_task missing roster or task", () => {
    const noRoster = twoPhases({ task: "t" });
    expect(PipelineManifestSchema.safeParse(noRoster).success).toBe(false);
    const noTask = twoPhases({ roster: "r.yaml" });
    expect(PipelineManifestSchema.safeParse(noTask).success).toBe(false);
  });
  it("rejects a non-dispatch_task kind carrying roster/task", () => {
    // Was `kind: "engineer"` until DF1.10 C19 removed that kind. `code` is now
    // the only other kind there is, so it is the only one that can carry the
    // fields it must not.
    const m = {
      ...base,
      phases: [
        { name: "e", kind: "code", command: ["true"], description: "x", roster: "r.yaml", task: "t" },
        { name: "tail", kind: "code", command: ["true"], description: "y" },
      ],
    };
    const result = PipelineManifestSchema.safeParse(m);
    expect(result.success).toBe(false);
    if (!result.success) {
      const detail = result.error.issues.map((i) => i.message).join("; ");
      expect(detail).toContain("roster is forbidden when kind is 'code'");
      expect(detail).toContain("task is forbidden when kind is 'code'");
    }
  });
});

describe("dispatch-task: F058 redaction map is the full parent env", () => {
  it("scrubs a secret that lives in the parent env under neither known provider key", async () => {
    const savedGh = process.env.GITHUB_TOKEN;
    const savedKey = process.env.ANTHROPIC_API_KEY;
    const savedRunner = process.env.QDS_TEAM_RUNNER;
    // A real credential the dispatch redactor never knew about: `phase.ts`
    // scrubs the SAME records against the whole of process.env, so the two
    // sinks disagreed about what "secret" means (F058).
    const secret = "ghp_F058AAAABBBBCCCCDDDDEEEEFFFF";
    process.env.GITHUB_TOKEN = secret;
    process.env.ANTHROPIC_API_KEY = "sk-test-key-long-enough";
    // The runner refusal echoes the offending value back — the cheapest sink
    // that puts caller-controlled text through `redact` before spawn.
    process.env.QDS_TEAM_RUNNER = secret;
    try {
      const spy = injectFake(() => successResult());
      const result = await runDispatch();
      expect(result.exitStatus).toBe("logic");
      expect(result.error?.message).not.toContain(secret);
      expect(result.error?.message).toContain("[REDACTED:GITHUB_TOKEN]");
      expect(spy.calls).toBe(0);
    } finally {
      // Restore ALL three: QDS_TEAM_RUNNER is deliberately set to the secret
      // here, so leaving it mutated makes every later dispatchTask in this file
      // take the same refusal path on an invalid runner value.
      for (const [name, saved] of [
        ["GITHUB_TOKEN", savedGh],
        ["ANTHROPIC_API_KEY", savedKey],
        ["QDS_TEAM_RUNNER", savedRunner],
      ] as const) {
        if (saved === undefined) {
          // Computed-key delete: noDelete does not flag this form, so no
          // suppression is needed. Unset is still the semantic — an assignment
          // would leave the literal string "undefined" in the env.
          delete process.env[name];
        } else {
          process.env[name] = saved;
        }
      }
    }
  });
});

describe("dispatch-task: F051 the gate records carry the RUN's requestId", () => {
  const VALIDATE_MODULE = "../../src/phase-engine/roster/validate.ts";

  it("stamps the run requestId on every RoleRecord, not a fresh UUID", async () => {
    // `validateRoster` mints `crypto.randomUUID()` when the caller passes none,
    // so a dispatch's gate records were uncorrelatable to their run. The only
    // seam that sees the report is the call itself: wrap it, pass through.
    const validate = await import(VALIDATE_MODULE);
    const real = validate.validateRoster;
    let recorded: string[] = [];
    // NOTE: restore-by-spread snapshots the module's bindings — a live binding
    // (a `let` the module reassigns, a getter) would be frozen at its value
    // here rather than restored. validate.ts exports only functions and consts
    // today, so the spread is faithful; a live export added there needs a real
    // restore instead of this one.
    const restore = () =>
      mock.module(VALIDATE_MODULE, () => ({ ...validate, validateRoster: real }));
    mock.module(VALIDATE_MODULE, () => ({
      ...validate,
      validateRoster: async (roster: never, gateDeps: never) => {
        const report = await real(roster, gateDeps);
        recorded = report.roles.map((r: { requestId: string }) => r.requestId);
        return report;
      },
    }));
    try {
      process.env.QDS_TEAM_RUNNER = "local";
      process.env.ANTHROPIC_API_KEY = "sk-test-key-long-enough";
      injectFake(() => successResult());
      await runDispatch();
      expect(recorded.length).toBeGreaterThan(0);
      expect(recorded.every((id) => id === "req-test")).toBe(true);
    } finally {
      restore();
    }
  });
});

/** Captures every process.stderr.write during `fn`, restoring the real
 * stream afterward, and returns the individual non-empty lines written. */
async function captureStderr(fn: () => Promise<unknown>): Promise<string[]> {
  const chunks: string[] = [];
  const origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    await fn();
  } finally {
    process.stderr.write = origWrite;
  }
  return chunks.join("").split("\n").filter((l) => l.length > 0);
}

/** Drives the dropped-artifact path (invalid name) through the DEFAULT log
 * sink (no `log` dep injected) so the assertion covers what actually reaches
 * real stderr, not just what an injected capture dep receives. */
function runDispatchTaskWithDroppedArtifact(): Promise<unknown> {
  process.env.QDS_TEAM_RUNNER = "local";
  process.env.ANTHROPIC_API_KEY = "sk-test-key-long-enough";
  injectFake(() =>
    successResult({ artifacts: [{ name: "", path: "dropped.txt" }] }),
  );
  return runDispatch();
}

describe("dispatch-task: F059 structured log sites", () => {
  test("every line dispatch-task writes to stderr is valid JSON", async () => {
    const lines = await captureStderr(() => runDispatchTaskWithDroppedArtifact());
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) expect(() => JSON.parse(l)).not.toThrow(); // dp:ok the parse IS the assertion — `expect(...).not.toThrow()` is the guard
  });

  it("captured log lines are all structured `type: \"log\"` objects", async () => {
    process.env.QDS_TEAM_RUNNER = "local";
    process.env.ANTHROPIC_API_KEY = "sk-test-key-long-enough";
    const captured: Record<string, unknown>[] = [];
    injectFake(() =>
      successResult({ artifacts: [{ name: "", path: "dropped.txt" }] }),
    );
    await runDispatch({}, { log: (l) => captured.push(l) });
    expect(captured.length).toBeGreaterThan(0);
    for (const l of captured) expect(l.type).toBe("log");
  });
});

// ---------------------------------------------------------------------------
// Verdict integrity through Run.phase (PR #135 round-5 finding).
//
// dispatch_task refusals and non-success classifications RETURN as values by
// DF1.6 design (schema-validated step output; the body never throws a
// refusal). Before the fix, Run.phase promoted any clean return to success —
// a refused dispatch journaled green and the run settled ok/exit 0. These
// legs drive every refusal path through a REAL Run + FileJournal: the
// persisted row, the halt, and the exit code are the acceptance surface.
// The direct-body assertions above are unchanged — the body still returns
// the same refusal values; only the engine's settle changed.
// ---------------------------------------------------------------------------

let engineSeq = 0;

/** Write a per-test roster INSIDE the repo (loadRoster's repo-root
 * confinement rejects tmpRoot) at a collision-safe path. Caller unlinks. */
function writeTempRoster(lines: string[]): string {
  const p = join(import.meta.dir, "fixtures", `.tmp-verdict-${randomUUID()}-${engineSeq++}.yaml`);
  writeFileSync(p, `${lines.join("\n")}\n`);
  return p;
}

/** Drive dispatchTask through Run.phase with a real FileJournal (tmpRoot-backed). */
async function runDispatchThroughEngine(
  over: Partial<PhaseSpec> = {},
  deps: DispatchTaskDeps = {},
) {
  const runId = `run-verdict-${engineSeq++}`;
  const file = join(tmpRoot, `journal-${runId}.json`);
  const run = new Run({
    ctx: { runId, pipelineId: "pipeline-verdict", requestId: "req-test" },
    journal: new FileJournal(file, runId),
    log: () => {},
  });
  const phaseSpec = spec(over);
  const outcome = await run.phase(
    phaseSpec,
    dispatchTask(phaseSpec, {
      tracer: fakeTracer as never,
      requestId: "req-test",
      rosterValidateDeps: offlineGate,
      ...deps,
    }),
  );
  return { outcome, row: readJournal(file).phases[0], run };
}
type EngineRun = Awaited<ReturnType<typeof runDispatchThroughEngine>>;

/** The shared verdict-integrity assertions: phase fail, journal row fail with
 * the real reason recorded, run halted. */
function expectPhaseFail(got: EngineRun, message: string | RegExp): void {
  expect(got.outcome.status).toBe("fail");
  expect(got.outcome.exitStatus).toBe("logic");
  expect(got.row?.status).toBe("fail");
  expect(got.row?.exitStatus).toBe("logic");
  if (typeof message === "string") expect(got.row?.error?.message).toContain(message);
  else expect(got.row?.error?.message).toMatch(message);
  expect(got.run.isHalted).toBe(true);
}

describe("dispatch-task: refusals settle the phase FAIL through Run.phase", () => {
  it("AC5: QDS_TEAM_RUNNER unset refuses -> fail, never spawns", async () => {
    const spy = injectFake(() => successResult());
    const got = await runDispatchThroughEngine();
    expectPhaseFail(got, "QDS_TEAM_RUNNER");
    expect(got.row?.error?.message).toContain("unset");
    expect(spy.calls).toBe(0);
  });

  it("AC5: QDS_TEAM_RUNNER=warren refuses -> fail, never spawns", async () => {
    process.env.QDS_TEAM_RUNNER = "warren";
    process.env.ANTHROPIC_API_KEY = "sk-test-key-long-enough";
    const spy = injectFake(() => successResult());
    const got = await runDispatchThroughEngine();
    expectPhaseFail(got, "QDS_TEAM_RUNNER");
    expect(got.row?.error?.message).toContain("warren");
    expect(spy.calls).toBe(0);
  });

  it("no provider key refuses -> fail naming keys by NAME only", async () => {
    process.env.QDS_TEAM_RUNNER = "local";
    const spy = injectFake(() => successResult());
    const got = await runDispatchThroughEngine();
    expectPhaseFail(got, "ANTHROPIC_API_KEY");
    expect(got.row?.error?.message).toContain("OPENROUTER_API_KEY");
    expect(spy.calls).toBe(0);
  });

  it("empty-string API key refuses -> fail", async () => {
    process.env.QDS_TEAM_RUNNER = "local";
    process.env.ANTHROPIC_API_KEY = "";
    const spy = injectFake(() => successResult());
    const got = await runDispatchThroughEngine();
    expectPhaseFail(got, "ANTHROPIC_API_KEY");
    expect(spy.calls).toBe(0);
  });

  it("whitespace-only API key refuses -> fail", async () => {
    process.env.QDS_TEAM_RUNNER = "local";
    process.env.ANTHROPIC_API_KEY = "   \t  ";
    const spy = injectFake(() => successResult());
    const got = await runDispatchThroughEngine();
    expectPhaseFail(got, "ANTHROPIC_API_KEY");
    expect(spy.calls).toBe(0);
  });

  it("INV-5: spec missing roster+task refuses -> fail", async () => {
    process.env.QDS_TEAM_RUNNER = "local";
    process.env.ANTHROPIC_API_KEY = "sk-test-key-long-enough";
    const spy = injectFake(() => successResult());
    const got = await runDispatchThroughEngine({ roster: undefined, task: undefined });
    expectPhaseFail(got, "requires roster and task");
    expect(spy.calls).toBe(0);
  });

  it("empty QDS_RUN_ROOT refuses -> fail", async () => {
    process.env.QDS_TEAM_RUNNER = "local";
    process.env.ANTHROPIC_API_KEY = "sk-test-key-long-enough";
    process.env.QDS_RUN_ROOT = "";
    const spy = injectFake(() => successResult());
    const got = await runDispatchThroughEngine();
    expectPhaseFail(got, "QDS_RUN_ROOT is empty");
    expect(spy.calls).toBe(0);
  });

  it("whitespace-only QDS_RUN_ROOT refuses -> fail", async () => {
    process.env.QDS_TEAM_RUNNER = "local";
    process.env.ANTHROPIC_API_KEY = "sk-test-key-long-enough";
    process.env.QDS_RUN_ROOT = "   \t  ";
    const spy = injectFake(() => successResult());
    const got = await runDispatchThroughEngine();
    expectPhaseFail(got, "QDS_RUN_ROOT is empty");
    expect(spy.calls).toBe(0);
  });

  it("unreadable roster refuses -> fail", async () => {
    process.env.QDS_TEAM_RUNNER = "local";
    process.env.ANTHROPIC_API_KEY = "sk-test-key-long-enough";
    const spy = injectFake(() => successResult());
    const got = await runDispatchThroughEngine({ roster: join(tmpRoot, "nope.yaml") });
    expect(got.outcome.status).toBe("fail");
    expect(got.outcome.exitStatus).toBe("logic");
    expect(got.row?.status).toBe("fail");
    expect(got.row?.error?.message).toBeTruthy();
    expect(got.run.isHalted).toBe(true);
    expect(spy.calls).toBe(0);
  });

  it("single-role roster refuses -> fail", async () => {
    process.env.QDS_TEAM_RUNNER = "local";
    process.env.ANTHROPIC_API_KEY = "sk-test-key-long-enough";
    const oneRole = writeTempRoster([
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
    ]);
    try {
      const spy = injectFake(() => successResult());
      const got = await runDispatchThroughEngine({ roster: oneRole });
      expectPhaseFail(got, "lead role");
      expect(spy.calls).toBe(0);
    } finally {
      try {
        unlinkSync(oneRole);
      } catch (e) {
        console.warn(`dispatch-task.test cleanup failed: ${oneRole}`, e instanceof Error ? e.message : String(e));
      }
    }
  });

  it("roster dual-gate rejection refuses -> fail with the gate's reason", async () => {
    process.env.QDS_TEAM_RUNNER = "local";
    process.env.ANTHROPIC_API_KEY = "sk-test-key-long-enough";
    const spy = injectFake(() => successResult());
    const got = await runDispatchThroughEngine(
      {},
      {
        rosterValidateDeps: {
          ...offlineGate,
          registryProblems: ["test-forced registry rejection"],
        },
      },
    );
    expectPhaseFail(got, "roster gate failed (exit 1)");
    expect(got.row?.error?.message).toContain("test-forced registry rejection");
    expect(spy.calls).toBe(0);
  });

  it("manifest schema refusal (>3 workers) -> fail, never a body throw past the engine", async () => {
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
    const rosterPath = writeTempRoster(lines);
    try {
      const spy = injectFake(() => successResult());
      const got = await runDispatchThroughEngine({ roster: rosterPath });
      expectPhaseFail(got, /(worker|cap|maximum|at most)/i);
      expect(got.row?.error?.message).not.toContain("outside the repo root");
      expect(spy.calls).toBe(0);
    } finally {
      try {
        unlinkSync(rosterPath);
      } catch (e) {
        console.warn(`dispatch-task.test cleanup failed: ${rosterPath}`, e instanceof Error ? e.message : String(e));
      }
    }
  });

  it("manifest directory blocked by a file refuses -> fail", async () => {
    process.env.QDS_TEAM_RUNNER = "local";
    process.env.ANTHROPIC_API_KEY = "sk-test-key-long-enough";
    writeFileSync(join(tmpRoot, ".qds-manifests"), "this is a file, not a directory");
    const spy = injectFake(() => successResult());
    const got = await runDispatchThroughEngine();
    expectPhaseFail(got, /manifest directory/i);
    expect(spy.calls).toBe(0);
  });
});

describe("dispatch-task: non-success RUN classifications settle the phase fail (no success promotion survives)", () => {
  it("runner settles lead_failure with no exit evidence -> phase fail/lead_failure with the reason", async () => {
    process.env.QDS_TEAM_RUNNER = "local";
    process.env.ANTHROPIC_API_KEY = "sk-test-key-long-enough";
    const spy = injectFake((opts) => {
      opts.onRunFacts?.({ exitCode: null, termSignal: null, killOrigin: null, comsInitError: null });
      return successResult({ exitStatus: "lead_failure" });
    });
    const got = await runDispatchThroughEngine();
    expect(got.outcome.status).toBe("fail");
    expect(got.outcome.exitStatus).toBe("lead_failure");
    expect(got.row?.status).toBe("fail");
    expect(got.row?.exitStatus).toBe("lead_failure");
    expect(got.row?.error?.message).toContain("lead_failure");
    expect(got.run.isHalted).toBe(true);
    expect(spy.calls).toBe(1); // this leg RAN the team — the verdict, not a refusal, fails the phase
  });

  it("a refused dispatch settles the run not-ok with exit code 1", async () => {
    // QDS_TEAM_RUNNER unset (beforeEach) — the AC5 refusal fires.
    const spy = injectFake(() => successResult());
    const got = await runDispatchThroughEngine();
    expect(got.outcome.status).toBe("fail");
    const fin = got.run.finish(true);
    expect(fin.ok).toBe(false);
    expect(fin.exitCode).toBe(1);
    expect(fin.banner).toContain("ok=false");
    expect(spy.calls).toBe(0);
  });

  it("positive control: a genuinely successful dispatch still promotes success and exit 0", async () => {
    process.env.QDS_TEAM_RUNNER = "local";
    process.env.ANTHROPIC_API_KEY = "sk-test-key-long-enough";
    injectFake((opts) => {
      feedLine(opts, '{"type":"merged","result":{"summary":"clean run"}}');
      opts.onRunFacts?.({ exitCode: 0, termSignal: null, killOrigin: null, comsInitError: null });
      return successResult();
    });
    const got = await runDispatchThroughEngine();
    expect(got.outcome.status).toBe("success");
    expect(got.outcome.exitStatus).toBe("success");
    expect(got.row?.status).toBe("success");
    expect(got.run.isHalted).toBe(false);
    const fin = got.run.finish(true);
    expect(fin.ok).toBe(true);
    expect(fin.exitCode).toBe(0);
  });
});
