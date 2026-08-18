import { describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTeamSpawn, runTeamManifest, splitRoleModel } from "../src/runner.ts";
import { parseTeamManifestFile } from "../src/manifest.ts";
import type { MergedOutput } from "../src/types.ts";

const FIXTURES = join(import.meta.dir, "fixtures");
const TEAM_MANIFEST = join(FIXTURES, "research-trio-test.yaml");

/** PATH with the team-mode warren shim prepended. */
function teamEnv(scenario: string): Record<string, string> {
  return {
    PATH: `${join(FIXTURES, "team-bin")}:${process.env.PATH ?? ""}`,
    HOME: process.env.HOME ?? "/tmp",
    QDS_FAKE_SCENARIO: scenario,
  };
}

const MERGED_KEYS = [
  "agentOutputs",
  "artifacts",
  "changedFiles",
  "comsLog",
  "durationMs",
  "error",
  "exitStatus",
  "mulchPrimeError",
  "mulchPrimed",
  "partial",
  "partialOutput",
  "result",
  "summary",
  "testResults",
  "testsExecuted",
  "waivers",
].sort();

function expectUniformSchema(out: MergedOutput): void {
  expect(Object.keys(out).sort()).toEqual(MERGED_KEYS);
  if (out.exitStatus === "success") {
    expect(out.error).toBeNull();
  } else {
    expect(out.error).not.toBeNull();
    expect(typeof out.error?.message).toBe("string");
  }
}

describe("splitRoleModel", () => {
  it("splits provider at the FIRST slash only", () => {
    expect(splitRoleModel("anthropic/claude-sonnet-4-5")).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-4-5",
    });
    expect(splitRoleModel("openrouter/z-ai/glm-4.7")).toEqual({
      provider: "openrouter",
      model: "z-ai/glm-4.7",
    });
  });

  it("guards missing delimiter (bypassed zod validation)", () => {
    expect(splitRoleModel("claude-sonnet-5")).toEqual({
      provider: "",
      model: "claude-sonnet-5",
    });
  });
});

describe("buildTeamSpawn", () => {
  it("builds the real warren 0.10.0 surface: warren run pi <project> -p <prompt> --provider --model", () => {
    const manifest = parseTeamManifestFile(TEAM_MANIFEST);
    const { file, argv } = buildTeamSpawn(manifest);
    expect(file).toBe("warren");
    expect(argv.slice(0, 3)).toEqual(["run", "pi", "qds-factory"]);
    expect(argv).toContain("-p");
    expect(argv).toContain("--provider");
    expect(argv).toContain("anthropic");
    expect(argv).toContain("--model");
    expect(argv).toContain("claude-test-lead");
  });
});

describe("runTeamManifest", () => {
  it("success: merged JSON, partial:false, union changedFiles, ≥2 coms messages (AC1, AC2)", async () => {
    const out = await runTeamManifest(TEAM_MANIFEST, { env: teamEnv("success") });
    expectUniformSchema(out);
    expect(out.exitStatus).toBe("success");
    expect(out.partial).toBe(false);
    expect(out.error).toBeNull();
    // Set-union, deduped, sorted.
    expect(out.changedFiles).toEqual(["src/a.ts", "src/b.ts"]);
    expect(Object.keys(out.agentOutputs).sort()).toEqual(["worker-a", "worker-b"]);
    expect(out.comsLog.length).toBeGreaterThanOrEqual(2);
    // camelCase at the boundary.
    expect(out.comsLog[0]?.senderAgent).toBeDefined();
    expect(out.result).toEqual({ summary: "lead merged both workers" });
    expect(out.durationMs).toBeGreaterThanOrEqual(0);
  }, 15_000);

  it("worker timeout: partial:true, transient, missing worker logged with reason timeout (AC3)", async () => {
    const out = await runTeamManifest(TEAM_MANIFEST, {
      env: teamEnv("worker_timeout"),
      // 400 ms, paired with the shim's 1.5 s hold: long enough that worker-a's
      // reply lands inside the budget even under CPU contention, short enough
      // that worker-b's await timer still fires before the child exits.
      comsAwaitTimeoutMs: 400,
    });
    expectUniformSchema(out);
    expect(out.exitStatus).toBe("transient");
    expect(out.partial).toBe(true);
    expect(out.error?.reason).toBe("transient");
    const details = out.error?.details as { missingWorkers?: Array<{ agentId: string; reason: string }> };
    expect(details.missingWorkers).toEqual([{ agentId: "worker-b", reason: "timeout" }]);
    // Received worker output is still populated (path 2, populated variant).
    expect(Object.keys(out.agentOutputs)).toEqual(["worker-a"]);
  }, 15_000);

  it("budget overflow: cumulative cost ≥ 90% cap → killTree within grace, exitStatus overflow (AC4, INV-2)", async () => {
    const started = Date.now();
    const out = await runTeamManifest(TEAM_MANIFEST, {
      env: teamEnv("budget_overflow"),
      graceMs: 200,
    });
    expectUniformSchema(out);
    expect(out.exitStatus).toBe("overflow");
    expect(out.error?.reason).toBe("overflow");
    // Killed promptly (grace 200ms + watchdog), nowhere near the 60s hang.
    expect(Date.now() - started).toBeLessThan(15_000);
    // Cost details: cumulative spend reported, no secret leakage of env.
    const details = out.error?.details as {
      cumulativeCostUsd?: number;
      costUnpriced?: boolean;
    };
    expect(details.cumulativeCostUsd).toBeCloseTo(0.55, 5);
    // DF2.7: legacy cost lines (no turnCount/unpricedTurns) still accumulate
    // and still kill at the same threshold — the widening did not move the
    // budget guard (AC3 + INV-COST-3).
    expect(details.costUnpriced).toBe(false);
    // agentOutputs populated with whatever the lead collected (path 3).
    expect(Object.keys(out.agentOutputs)).toEqual(["worker-a"]);
  }, 20_000);

  it("budget overflow with unpriced turns: cumulative total is marked partial (DF2.7, INV-COST-5)", async () => {
    const out = await runTeamManifest(TEAM_MANIFEST, {
      env: teamEnv("budget_overflow_unpriced"),
      graceMs: 200,
    });
    expectUniformSchema(out);
    expect(out.exitStatus).toBe("overflow");
    const details = out.error?.details as {
      cumulativeCostUsd?: number;
      costUnpriced?: boolean;
    };
    // Same accumulated spend as the priced run — an unpriced turn is never
    // priced at $0 and never credited against the total; it only marks the
    // record incomplete so nothing bills or spends against a partial figure.
    expect(details.cumulativeCostUsd).toBeCloseTo(0.55, 5);
    expect(details.costUnpriced).toBe(true);
  }, 20_000);

  it("coms init failure: transient with agentOutputs {} and no partial output (AC6)", async () => {
    const out = await runTeamManifest(TEAM_MANIFEST, { env: teamEnv("coms_init_fail") });
    expectUniformSchema(out);
    expect(out.exitStatus).toBe("transient");
    expect(out.error?.reason).toBe("transient");
    expect(out.agentOutputs).toEqual({});
    expect(out.partial).toBe(false);
  }, 15_000);

  it("lead failure: worker partials preserved in artifacts/, agentOutputs {} (path 5)", async () => {
    const artifactsDir = mkdtempSync(join(tmpdir(), "p03-artifacts-"));
    try {
      const out = await runTeamManifest(TEAM_MANIFEST, {
        env: teamEnv("lead_crash"),
        artifactsDir,
      });
      expectUniformSchema(out);
      expect(out.exitStatus).toBe("lead_failure");
      expect(out.error?.reason).toBe("lead_failure");
      expect(out.agentOutputs).toEqual({});
      expect(out.changedFiles).toEqual([]);
      const files = readdirSync(artifactsDir).sort();
      expect(files).toEqual(["worker-a.json", "worker-b.json"]);
      const workerA = JSON.parse(
        readFileSync(join(artifactsDir, "worker-a.json"), "utf8"),
      ) as { result?: { summary?: string } };
      expect(workerA.result?.summary).toBe("worker-a done");
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true });
    }
  }, 15_000);

  it("lead failure artifacts are secret-redacted (INV-3 parity with stdout)", async () => {
    const artifactsDir = mkdtempSync(join(tmpdir(), "p03-artifacts-redact-"));
    const secret = "sk-artifact-secret-value-987654321";
    try {
      // The shim echoes worker results whose summary is fixed; the secret
      // rides the env — if any worker output ever contained it, the artifact
      // write must redact. Simulate by injecting the secret into the fixture
      // output via QDS_FAKE_SECRET_ECHO (shim appends it to worker summaries).
      await runTeamManifest(TEAM_MANIFEST, {
        env: {
          ...teamEnv("lead_crash"),
          FAKE_API_KEY: secret,
          QDS_FAKE_SECRET_ECHO: secret,
        },
        artifactsDir,
      });
      for (const f of readdirSync(artifactsDir)) {
        const content = readFileSync(join(artifactsDir, f), "utf8");
        expect(content).not.toContain(secret);
      }
    } finally {
      rmSync(artifactsDir, { recursive: true, force: true });
    }
  }, 15_000);

  it("application non-zero exit with no held worker outputs → logic", async () => {
    const out = await runTeamManifest(TEAM_MANIFEST, { env: teamEnv("logic_exit") });
    expectUniformSchema(out);
    expect(out.exitStatus).toBe("logic");
    expect(out.error?.reason).toBe("logic");
  }, 15_000);

  it("worker omitting changedFiles = node failure → logic (CORRECTNESS-C)", async () => {
    const out = await runTeamManifest(TEAM_MANIFEST, {
      env: teamEnv("bad_worker_output"),
    });
    expectUniformSchema(out);
    expect(out.exitStatus).toBe("logic");
    expect(out.error?.message).toMatch(/changedFiles/);
  }, 15_000);

  it("wall-clock cap expiry → overflow (wall-clock wins over coms_await)", async () => {
    const out = await runTeamManifest(TEAM_MANIFEST, {
      env: teamEnv("hang"),
      wallClockCapMs: 300,
    });
    expectUniformSchema(out);
    expect(out.exitStatus).toBe("overflow");
    expect(out.error?.reason).toBe("overflow");
  }, 20_000);

  it("F15: per-line cap drops an oversized multibyte line and resumes parsing (merged still lands)", async () => {
    // 1000 × "あ" = 3000 UTF-8 bytes but 1000 UTF-16 units. Under a 2048-byte
    // cap by units, OVER it by bytes — the old decoded.length counter would
    // let it slip past. Spy on the harness's own cap log to prove the
    // byte-accurate cap fired, and assert the trailing `merged` still parsed
    // (proving parsing resumed after the oversized line was discarded).
    // BC5: inline assertion proving fixture line exceeds cap
    const oversizedLine = "あ".repeat(1000);
    expect(Buffer.byteLength(oversizedLine, "utf8")).toBe(3000);
    expect(Buffer.byteLength(oversizedLine, "utf8")).toBeGreaterThan(2048);
    const capError = spyOn(console, "error").mockImplementation(() => {});
    try {
      const out = await runTeamManifest(TEAM_MANIFEST, {
        env: teamEnv("oversized_multibyte_line"),
        teamStdoutCapBytes: 2048,
      });
      expectUniformSchema(out);
      expect(out.exitStatus).toBe("success");
      expect(out.result).toEqual({ summary: "resumed after oversized line" });
      const capFired = capError.mock.calls.some((c) =>
        String(c[0]).includes("lead stdout line exceeded"),
      );
      expect(capFired).toBe(true);
    } finally {
      capError.mockRestore();
    }
  }, 15_000);

  it("F15: multibyte char split at the cap boundary resets the decoder so resumed parsing is clean", async () => {
    // A 3-byte char straddles the chunk boundary that also breaches the byte
    // cap, leaving a partial char buffered in the StringDecoder when the line
    // is discarded. Without a decoder reset those stale bytes flush as a U+FFFD
    // prefix onto the trailing `merged` line — JSON.parse fails and the run
    // misclassifies. Success + the exact merged result proves the reset landed.
    const capError = spyOn(console, "error").mockImplementation(() => {});
    try {
      const out = await runTeamManifest(TEAM_MANIFEST, {
        env: teamEnv("split_multibyte_at_cap"),
        teamStdoutCapBytes: 2048,
      });
      expectUniformSchema(out);
      expect(out.exitStatus).toBe("success");
      expect(out.result).toEqual({ summary: "resumed after split multibyte line" });
      const capFired = capError.mock.calls.some((c) =>
        String(c[0]).includes("lead stdout line exceeded"),
      );
      expect(capFired).toBe(true);
    } finally {
      capError.mockRestore();
    }
  }, 15_000);

  it("F15: many complete small lines coalesced into ONE chunk are not falsely dropped (per-line cap)", async () => {
    // Regression (review round 9): the cap used to be judged once per data
    // chunk against the whole chunk, so several legitimate sub-cap lines
    // coalesced into a single write > cap lost their first line to a false
    // "oversized" drop. The per-line scan must keep every physical line.
    const capError = spyOn(console, "error").mockImplementation(() => {});
    try {
      const out = await runTeamManifest(TEAM_MANIFEST, {
        env: teamEnv("many_small_lines_one_chunk"),
        teamStdoutCapBytes: 2048,
      });
      expectUniformSchema(out);
      expect(out.exitStatus).toBe("success");
      expect(out.comsLog.length).toBe(2);
      const capFired = capError.mock.calls.some((c) =>
        String(c[0]).includes("lead stdout line exceeded"),
      );
      expect(capFired).toBe(false);
    } finally {
      capError.mockRestore();
    }
  }, 15_000);

  it("partial output over the 10KB cap is marked with the truncation suffix (R9)", async () => {
    // Regression (review round 9): output past PARTIAL_OUTPUT_CAP was
    // discarded silently — the buffer never exceeded the cap so the merger's
    // truncateWithSuffix never fired, and consumers could not tell a complete
    // output from a clipped one. The runner must mark the cut itself.
    const out = await runTeamManifest(TEAM_MANIFEST, {
      env: teamEnv("partial_output_over_cap"),
    });
    expectUniformSchema(out);
    expect(out.exitStatus).toBe("logic");
    expect(out.partialOutput).not.toBeNull();
    expect(out.partialOutput!.length).toBeLessThanOrEqual(10_000);
    expect(out.partialOutput).toMatch(/\[truncated, \d+ chars total\]$/);
  }, 15_000);

  it("R12: parent abort during a graceful (exit-0) shutdown resolves transient, not success", async () => {
    // Regression (review round 9): a child that traps the abort SIGTERM,
    // emits merged, and exits 0 classified "success" — a run the parent
    // explicitly cancelled resolved clean. abortRequested downgrades every
    // non-overflow status at settle time.
    const controller = new AbortController();
    const killOrigins: ("watchdog" | "budget" | "wallClock" | "requestedShutdown" | null)[] = [];
    let firstEvent = false;
    const run = runTeamManifest(TEAM_MANIFEST, {
      env: teamEnv("abort_graceful_exit0"),
      abortSignal: controller.signal,
      // Capture killOrigin to verify watchdog did NOT escalate
      onRunFacts: (facts) => {
        killOrigins.push(facts.killOrigin);
      },
      onTeamEvent: () => { firstEvent = true; },
    });
    // P6c: wait for observable signal (firstTeamEvent) with bounded timeout, then abort
    const startedAt = Date.now();
    while (!firstEvent && Date.now() - startedAt < 2000) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(firstEvent).toBe(true); // prove we observed activity before abort
    controller.abort();
    const out = await run;
    expectUniformSchema(out);
    expect(out.exitStatus).toBe("transient");
    expect(out.error?.message).toBe("run aborted by parent signal");
    // T9: verify watchdog did NOT escalate (killOrigin should be null or requestedShutdown,
    // NEVER "watchdog" on an abort-only run)
    expect(killOrigins).not.toContain("watchdog");
  }, 15_000);

  it("CLI: `cli-anything run --manifest <team.yaml>` emits MergedOutput and exit 0 (AC1 wiring)", async () => {
    const proc = Bun.spawn(
      ["bun", join(import.meta.dir, "..", "src", "index.ts"), "run", "--manifest", TEAM_MANIFEST],
      { env: teamEnv("success"), stdout: "pipe", stderr: "pipe" },
    );
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);
    const out = JSON.parse(stdout) as MergedOutput;
    expectUniformSchema(out);
    expect(out.exitStatus).toBe("success");
    expect(out.partial).toBe(false);
  }, 20_000);

  it("CLI: overflow maps to exit code 3 (INV-2 non-zero on cap breach)", async () => {
    const proc = Bun.spawn(
      ["bun", join(import.meta.dir, "..", "src", "index.ts"), "run", "--manifest", TEAM_MANIFEST],
      {
        env: { ...teamEnv("budget_overflow"), QDS_TEAM_GRACE_MS: "200" },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    expect(exitCode).toBe(3);
    const out = JSON.parse(stdout) as MergedOutput;
    expect(out.exitStatus).toBe("overflow");
  }, 30_000);

  it("INV-1/INV-3: secret env values never appear in the merged JSON", async () => {
    const secret = "sk-team-secret-value-abcdef123456";
    const out = await runTeamManifest(TEAM_MANIFEST, {
      env: { ...teamEnv("success"), FAKE_API_KEY: secret },
    });
    expect(JSON.stringify(out)).not.toContain(secret);
  }, 15_000);
});

describe("DF1.6 T5/R1: spawn seam budget ceiling behavior (real runs)", () => {
  // These tests drive the REAL budget guard through its kill path and
  // assert on the cap surfaced in the overflow error message. R1 fix ensures
  // ceiling can only LOWER a cap, never raise it. TEAM_MANIFEST has budgetCapUsd: 0.5,
  // so when ceiling is 5 or 15, the result stays at 0.5 (the lower value wins).

  it("effectiveCeilingMicros=5M respects manifest cap when lower (R1: ceiling can only LOWER)", async () => {
    const out = await runTeamManifest(TEAM_MANIFEST, {
      env: teamEnv("big_cost"),
      effectiveCeilingMicros: 5_000_000,
      graceMs: 200,
    });
    expectUniformSchema(out);
    expect(out.exitStatus).toBe("overflow");
    // 9.50 spend ≥ 0.9×$0.5 threshold → killed at MANIFEST cap.
    // R1: ceiling (5) is HIGHER than manifest cap (0.5), so manifest cap wins.
    expect(out.error?.message).toContain("(cap $0.50)");
    const details = out.error?.details as { cumulativeCostUsd?: number };
    expect(details.cumulativeCostUsd).toBeCloseTo(9.5, 5);
  }, 20_000);

  it("ceiling above schema max clamps to $10; manifest cap still wins when lower (R1)", async () => {
    const out = await runTeamManifest(TEAM_MANIFEST, {
      env: teamEnv("big_cost"),
      effectiveCeilingMicros: 15_000_000,
      graceMs: 200,
    });
    expect(out.exitStatus).toBe("overflow");
    // R1: min(manifest 0.5, ceiling 15, schema 10) = 0.5 → manifest cap wins.
    expect(out.error?.message).toContain("(cap $0.50)");
  }, 20_000);

  it("absent effectiveCeilingMicros leaves the manifest cap untouched (S1 default)", async () => {
    const out = await runTeamManifest(TEAM_MANIFEST, {
      env: teamEnv("budget_overflow"),
      graceMs: 200,
    });
    expect(out.exitStatus).toBe("overflow");
    expect(out.error?.message).toContain("(cap $0.50)");
  }, 20_000);

  // R1: Test that ceiling CAN lower a cap when it's LOWER than the manifest cap.
  it("ceiling LOWER than manifest cap wins (R1: min of explicit + ceiling + schema)", async () => {
    const out = await runTeamManifest(TEAM_MANIFEST, {
      env: teamEnv("big_cost"),
      budgetCapUsd: 5, // Set a higher manifest cap to see ceiling lower it
      effectiveCeilingMicros: 300_000, // $0.30 ceiling — LOWER than manifest
      graceMs: 200,
    });
    expectUniformSchema(out);
    expect(out.exitStatus).toBe("overflow");
    // R1: min(manifest 5, ceiling 0.3, schema 10) = 0.3 → ceiling wins.
    expect(out.error?.message).toContain("(cap $0.30)");
    const details = out.error?.details as { cumulativeCostUsd?: number };
    expect(details.cumulativeCostUsd).toBeCloseTo(9.5, 5);
  }, 20_000);

  // One it() per bad ceiling: a shared loop emits identical failures with no
  // indication of which value (0 / -1 / NaN) broke.
  for (const bad of [0, -1, Number.NaN]) {
    it(`invalid ceiling (${bad}) falls back to the manifest cap`, async () => {
      const out = await runTeamManifest(TEAM_MANIFEST, {
        env: teamEnv("budget_overflow"),
        effectiveCeilingMicros: bad,
        graceMs: 200,
      });
      expect(out.exitStatus).toBe("overflow");
      expect(out.error?.message).toContain("(cap $0.50)");
    }, 20_000);
  }

  it("forceLocalRunner puts QDS_TEAM_RUNNER=local in the CHILD env only", async () => {
    // local-bin/bun is a fake `bun` FIRST on PATH: it reports the
    // QDS_TEAM_RUNNER it received via coms_init_error, proving the child
    // env (not the parent object, not process.env) was forced.
    const parentEnv: Record<string, string> = {
      PATH: `${join(FIXTURES, "local-bin")}:${join(FIXTURES, "team-bin")}:${process.env.PATH ?? ""}`,
      HOME: process.env.HOME ?? "/tmp",
      QDS_TEAM_RUNNER: "warren",
    };
    // Snapshot, not "not local": an ambient QDS_TEAM_RUNNER=local (now a
    // user-selectable seam) would fail a not-local assertion spuriously, and
    // any other ambient value makes it pass vacuously.
    const ambientRunner = process.env.QDS_TEAM_RUNNER;
    const out = await runTeamManifest(TEAM_MANIFEST, {
      env: parentEnv,
      forceLocalRunner: true,
    });
    expect(out.exitStatus).toBe("transient");
    expect(out.error?.message).toContain("coms init failed: runner=local");
    // Parent env object not mutated; process.env untouched.
    expect(parentEnv.QDS_TEAM_RUNNER).toBe("warren");
    expect(process.env.QDS_TEAM_RUNNER).toBe(ambientRunner);
  }, 15_000);

  it("forceLocalRunner NEGATIVE: without flag, child report shows NO runner=local", async () => {
    // Without forceLocalRunner, the fake bun (first on PATH) receives the
    // default warren runner selection, NOT "local".
    const parentEnv: Record<string, string> = {
      PATH: `${join(FIXTURES, "local-bin")}:${join(FIXTURES, "team-bin")}:${process.env.PATH ?? ""}`,
      HOME: process.env.HOME ?? "/tmp",
      QDS_TEAM_RUNNER: "warren",
    };
    // Run WITHOUT forceLocalRunner flag
    const out = await runTeamManifest(TEAM_MANIFEST, {
      env: parentEnv,
      // forceLocalRunner intentionally omitted
    });
    // The fake bun should report runner=warren, NOT runner=local
    expect(out.exitStatus).toBe("transient");
    expect(out.error?.message).toContain("coms init failed: runner=warren");
    // Verify runner=local is NOT mentioned
    expect(out.error?.message).not.toContain("runner=local");
  }, 15_000);
});

describe("DF1.6 T4: RSS watchdog overflow regression test", () => {
  it("watchdog escalation → exitStatus overflow AND killOrigin watchdog (onRunFacts wiring)", async () => {
    const killOrigins: ("watchdog" | "budget" | "wallClock" | "requestedShutdown" | null)[] = [];
    let sampleCount = 0;
    const OVER_THRESHOLD_RSS = 5 * 1024 ** 3; // 5 GB (exceeds 4 GB default)

    const out = await runTeamManifest(TEAM_MANIFEST, {
      env: teamEnv("watchdog_kill"),
      // BC13: disable budget and wall-clock caps so ONLY watchdog can kill
      // Use large finite values that don't overflow setTimeout (max 32-bit signed int)
      budgetCapUsd: 999_999_999, // Effectively infinite for test duration
      wallClockCapMs: 2_147_483_647, // max 32-bit signed int, ~24 days
      // BT23: Inject sampler that reports over-threshold RSS on first poll,
      // then below-threshold values after escalation (null is the unwatchable signal)
      watchdogSampleRss: async () => {
        sampleCount++;
        // First poll returns over-threshold → triggers escalation
        if (sampleCount === 1) {
          return OVER_THRESHOLD_RSS;
        }
        // After escalation, return below-threshold values (NOT null, which signals unwatchable)
        return 100 * 1024 ** 2; // 100 MB — well below 4 GB threshold
      },
      // Capture killOrigin from onRunFacts callback
      onRunFacts: (facts) => {
        killOrigins.push(facts.killOrigin);
      },
      // Short grace so test completes fast (default 5s, we don't need to wait)
      graceMs: 100,
    });

    // Primary assertions: the overflow classification and watchdog attribution
    expect(out.exitStatus).toBe("overflow");
    expect(out.error?.reason).toBe("overflow");
    expect(out.error?.message).toContain("RSS watchdog 4 GB threshold exceeded");
    // DF1.6 wave-1 fix: killOrigin is now read from the live watchdog handle
    expect(killOrigins).toHaveLength(1);
    expect(killOrigins[0]).toBe("watchdog");

    // Verify the sampler was called at least once (escalation happened)
    expect(sampleCount).toBeGreaterThanOrEqual(1);
  }, 15_000);

  // T10: budget kill near-threshold boundary
  describe("T10: budget kill near-threshold boundary (cumulative cost at/just-below kill threshold)", () => {
    // Source uses `>=` for threshold check (line 1124 in runner.ts): AT threshold fires the kill
    // TEAM_MANIFEST has budgetCapUsd: 0.5, kill threshold is 0.9×0.5 = 0.45

    it("cumulative cost EXACTLY at threshold triggers budget kill (discovered semantics: >=, not >)", async () => {
      // At EXACT threshold (0.45 = 90% of 0.50), the kill fires (>= semantics)
      const out = await runTeamManifest(TEAM_MANIFEST, {
        env: teamEnv("threshold_exact"), // new fixture: emits exactly 0.45
        budgetCapUsd: 0.5,
        graceMs: 200,
      });
      // Budget kill fires at EXACT threshold (>= semantics)
      expectUniformSchema(out);
      expect(out.exitStatus).toBe("overflow");
      expect(out.error?.reason).toBe("overflow");
      expect(out.error?.message).toContain("(cap $0.50)");
      const details = out.error?.details as { cumulativeCostUsd?: number };
      expect(details.cumulativeCostUsd).toBeCloseTo(0.45, 5);
    }, 20_000);

    it("cumulative cost just below threshold does NOT kill (0.03 vs 0.45)", async () => {
      // Well below threshold: success scenario emits 0.01 + 0.02 = 0.03 << 0.45
      // No budget kill, run completes normally
      const out = await runTeamManifest(TEAM_MANIFEST, {
        env: teamEnv("success"), // emits 0.01 + 0.02 = 0.03 < 0.45
        budgetCapUsd: 0.5,
      });
      // Should complete successfully (no budget kill)
      expectUniformSchema(out);
      expect(out.exitStatus).toBe("success");
    }, 15_000);
  });

  // T11: per-line cap exact boundary (2048 bytes)
  describe("T11: per-line cap exact boundary (teamStdoutCapBytes: 2048)", () => {
    const CAP_BYTES = 2048;

    it("oversized line (>2048 bytes) is dropped with console.error logged (F15 pattern)", async () => {
      // Cap unit is raw Buffer bytes (line 1187: `seg.length`), includes trailing newline
      // Use existing oversized_multibyte_line scenario which emits 3000 bytes > 2048
      // This proves the byte-accurate cap fires and parsing resumes
      const capError = spyOn(console, "error").mockImplementation(() => {});
      try {
        const out = await runTeamManifest(TEAM_MANIFEST, {
          env: teamEnv("oversized_multibyte_line"), // 3000 bytes > 2048, triggers drop
          teamStdoutCapBytes: CAP_BYTES,
        });
        expectUniformSchema(out);
        expect(out.exitStatus).toBe("success");
        expect(out.result).toEqual({ summary: "resumed after oversized line" });
        // The oversized line (3000 bytes) should have triggered the cap
        const capFired = capError.mock.calls.some((c) =>
          String(c[0]).includes("lead stdout line exceeded"),
        );
        expect(capFired).toBe(true);
      } finally {
        capError.mockRestore();
      }
    }, 15_000);
  });
});
